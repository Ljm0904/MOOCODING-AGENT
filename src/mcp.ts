import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sseData } from './providers/http.ts';
import type { Tool } from './types.ts';
import { c, type UI } from './ui.ts';
import { MOO_HOME, sha } from './util.ts';

/** Same shape as Claude Code's `.mcp.json`: { "mcpServers": { name: { command,args,env } | { url,headers } } } */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
  annotations?: { readOnlyHint?: boolean };
}

const PROTOCOL = '2025-06-18';

export class McpConnection {
  name: string;
  cfg: McpServerConfig;
  tools: McpToolDef[] = [];
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderrTail = '';
  private sessionId?: string;
  private closed = false;

  constructor(name: string, cfg: McpServerConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  async connect(timeoutMs = 20_000): Promise<void> {
    if (this.cfg.command) {
      const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
        cwd: this.cfg.cwd,
        env: { ...process.env, ...this.cfg.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      let buf = '';
      proc.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            this.onMessage(JSON.parse(line));
          } catch {
            /* not JSON: server logging on stdout; ignore */
          }
        }
      });
      proc.stderr!.on('data', (d: Buffer) => (this.stderrTail = (this.stderrTail + d.toString()).slice(-1500)));
      proc.stdin!.on('error', () => {});
      proc.on('error', (e) => this.failAll(new Error(`failed to start: ${e.message}`)));
      proc.on('exit', (code) => {
        this.closed = true;
        this.failAll(new Error(`server exited (code ${code})${this.stderrTail ? ': ' + this.stderrTail.trim().split('\n').pop() : ''}`));
      });
    } else if (!this.cfg.url) {
      throw new Error('server needs "command" or "url"');
    }

    await this.request(
      'initialize',
      { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'moo', version: '0.1.0' } },
      timeoutMs,
    );
    await this.notify('notifications/initialized');

    let cursor: string | undefined;
    do {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs);
      this.tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor);
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onMessage(m: any) {
    if (Array.isArray(m)) return m.forEach((x) => this.onMessage(x));
    if (m.id !== undefined && m.method) {
      // server → client request. We advertise no capabilities, but answer ping.
      void this.send(m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not supported' } });
      return;
    }
    if (m.id === undefined) return; // notification
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(`${m.error.message ?? 'MCP error'} (${m.error.code})`));
    else p.resolve(m.result);
  }

  private async send(msg: object): Promise<void> {
    if (this.proc) {
      if (this.closed) throw new Error('server is not running');
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
      return;
    }
    // Streamable HTTP: the reply arrives in the POST response (JSON or SSE).
    const res = await fetch(this.cfg.url!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.cfg.headers,
      },
      body: JSON.stringify(msg),
    });
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (res.status === 202) return;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for await (const data of sseData(res)) {
        try {
          this.onMessage(JSON.parse(data));
        } catch {}
      }
    } else {
      this.onMessage(await res.json());
    }
  }

  request(method: string, params: object, timeoutMs = 60_000, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(id)) {
            clearTimeout(timer);
            void this.notify('notifications/cancelled', { requestId: id, reason: 'user interrupt' }).catch(() => {});
            reject(new Error('interrupted'));
          }
        },
        { once: true },
      );
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(e);
        }
      });
    });
  }

  async notify(method: string, params?: object) {
    await this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  close() {
    this.closed = true;
    try {
      this.proc?.kill();
    } catch {}
  }
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

function flattenResult(r: any): string {
  const parts: string[] = [];
  for (const b of r?.content ?? []) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'image') parts.push(`[image ${b.mimeType ?? ''}, ${String(b.data ?? '').length} base64 chars not shown]`);
    else if (b.type === 'resource') parts.push(b.resource?.text ?? `[resource ${b.resource?.uri ?? ''}]`);
    else if (b.type === 'resource_link') parts.push(`[resource ${b.uri}]`);
    else parts.push(JSON.stringify(b));
  }
  if (!parts.length && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
  return parts.join('\n') || '(empty result)';
}

export function toTool(conn: McpConnection, def: McpToolDef): Tool {
  return {
    spec: {
      name: `mcp__${sanitize(conn.name)}__${sanitize(def.name)}`.slice(0, 64),
      description: `[MCP server "${conn.name}"] ${def.description ?? def.name}`,
      input_schema: def.inputSchema ?? { type: 'object', properties: {} },
    },
    readOnly: def.annotations?.readOnlyHint === true,
    kind: 'other',
    describe: (i) => `${conn.name}:${def.name} ${JSON.stringify(i).slice(0, 100)}`,
    async run(input, ctx) {
      const r = await conn.request('tools/call', { name: def.name, arguments: input }, 120_000, ctx.signal);
      const text = flattenResult(r);
      if (r?.isError) throw new Error(text);
      return text;
    },
  };
}

// ---------- discovery, trust, lifecycle ----------

function expand(v: string): string {
  return v.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? '');
}

function expandCfg(cfg: McpServerConfig): McpServerConfig {
  const mapObj = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)])) : undefined);
  return {
    ...cfg,
    command: cfg.command && expand(cfg.command),
    args: cfg.args?.map(expand),
    url: cfg.url && expand(cfg.url),
    env: mapObj(cfg.env),
    headers: mapObj(cfg.headers),
  };
}

function readServers(file: string): Record<string, McpServerConfig> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {};
  } catch (e: any) {
    console.error(c.yellow(`Warning: cannot parse ${file}: ${e.message}`));
    return {};
  }
}

const describeCfg = (n: string, s: McpServerConfig) => `${n}: ${s.command ? [s.command, ...(s.args ?? [])].join(' ') : s.url}`;

async function projectTrusted(cwd: string, servers: Record<string, McpServerConfig>, ui: UI): Promise<boolean> {
  const trustFile = join(MOO_HOME, 'mcp-trust.json');
  const key = sha(cwd + JSON.stringify(servers));
  let trust: Record<string, boolean> = {};
  try {
    trust = JSON.parse(readFileSync(trustFile, 'utf8'));
  } catch {}
  if (trust[key]) return true;
  ui.warn('This project\'s .mcp.json wants to start MCP servers (they run code on your machine):');
  for (const [n, s] of Object.entries(servers)) ui.line('  ' + describeCfg(n, s));
  const ans = (await ui.ask('Trust and start them? [y]es (remember) / [n]o: ')).toLowerCase();
  if (ans !== 'y' && ans !== 'yes') return false;
  mkdirSync(MOO_HOME, { recursive: true });
  trust[key] = true;
  writeFileSync(trustFile, JSON.stringify(trust, null, 2));
  return true;
}

export interface McpStatus {
  name: string;
  ok: boolean;
  tools: string[];
  error?: string;
  transport: 'stdio' | 'http';
}

export interface McpManager {
  tools: Tool[];
  status: McpStatus[];
  closeAll(): void;
}

/** Load ~/.moo/mcp.json and <cwd>/.mcp.json (project wins), connect in parallel, expose tools. */
export async function connectMcp(cwd: string, ui: UI): Promise<McpManager> {
  const user = readServers(join(MOO_HOME, 'mcp.json'));
  let project = readServers(join(cwd, '.mcp.json'));
  if (Object.keys(project).length && !(await projectTrusted(cwd, project, ui))) project = {};
  const all = { ...user, ...project };
  const conns: McpConnection[] = [];
  const status: McpStatus[] = [];
  const tools: Tool[] = [];

  await Promise.all(
    Object.entries(all).map(async ([name, raw]) => {
      const conn = new McpConnection(name, expandCfg(raw));
      const transport = raw.command ? 'stdio' : 'http';
      try {
        await conn.connect();
        conns.push(conn);
        const ts = conn.tools.map((d) => toTool(conn, d));
        tools.push(...ts);
        status.push({ name, ok: true, tools: ts.map((t) => t.spec.name), transport });
      } catch (e: any) {
        conn.close();
        status.push({ name, ok: false, tools: [], error: e.message, transport });
      }
    }),
  );
  const seen = new Set<string>();
  const unique = tools.filter((t) => !seen.has(t.spec.name) && seen.add(t.spec.name));
  return { tools: unique, status, closeAll: () => conns.forEach((x) => x.close()) };
}
