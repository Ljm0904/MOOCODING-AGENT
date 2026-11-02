import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

process.env.FORCE_COLOR = '1';
process.env.MOO_HOME = mkdtempSync(join(tmpdir(), 'moo-home2-'));
const { MdStream, renderInline } = await import('../src/markdown.ts');
const { McpConnection, toTool, connectMcp } = await import('../src/mcp.ts');
const { UI } = await import('../src/ui.ts');

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const fake = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));

describe('markdown', () => {
  it('renders inline styles', () => {
    assert.equal(renderInline('a **b** `c` [d](http://x)'), `a \x1b[1mb\x1b[22m \x1b[36mc\x1b[39m \x1b[4md\x1b[24m \x1b[2m(http://x)\x1b[22m`);
    assert.equal(strip(renderInline('snake_case *it*')), 'snake_case it');
    assert.equal(renderInline('2 * 3 * 4'), '2 * 3 * 4'); // not italic
  });

  it('renders blocks incrementally across arbitrary chunk boundaries', () => {
    const src = '# Title\n- item **x**\n1. one\n```ts\nconst a = **1**;\n```\n> quote\n---\nplain';
    const md = new MdStream(true);
    let out = '';
    for (const ch of src.match(/.{1,3}/gs)!) out += md.push(ch);
    assert.equal(md.pending, true); // last line has no newline yet
    out += md.flush();
    const lines = strip(out).split('\n');
    assert.deepEqual(lines, ['Title', '• item x', '1. one', '  ┌─ ts', '  │ const a = **1**;', '  └─', '│ quote', '─'.repeat(40), 'plain']);
  });

  it('passes text through untouched when disabled', () => {
    const md = new MdStream(false);
    assert.equal(md.push('# raw **x**'), '# raw **x**');
  });
});

describe('MCP', () => {
  it('stdio: handshake, list, call, isError, readOnly hint', async () => {
    const conn = new McpConnection('fake srv', { command: process.execPath, args: [fake] });
    await conn.connect();
    const tools = conn.tools.map((d) => toTool(conn, d));
    assert.deepEqual(tools.map((t) => t.spec.name), ['mcp__fake_srv__echo', 'mcp__fake_srv__boom']);
    assert.equal(tools[0]!.readOnly, true);
    assert.equal(tools[1]!.readOnly, false);
    const ctx = { cwd: '.', agentId: 't', setTodos() {}, setPlan() {}, requestStop() {} };
    assert.equal(await tools[0]!.run({ text: 'hi' }, ctx), 'echo:hi');
    await assert.rejects(tools[1]!.run({}, ctx), /kaboom/);
    conn.close();
  });

  it('stdio: reports a server that exits immediately', async () => {
    const conn = new McpConnection('dead', { command: process.execPath, args: ['-e', 'process.exit(3)'] });
    await assert.rejects(conn.connect(5000), /exited/);
  });

  it('streamable HTTP: JSON and SSE responses, session id', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        const m = JSON.parse(b);
        seen.push(`${m.method}:${req.headers['mcp-session-id'] ?? '-'}`);
        if (m.id === undefined) return void res.writeHead(202).end();
        const result =
          m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
          : m.method === 'tools/list' ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'pong' }] };
        const body = JSON.stringify({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'tools/call') res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${body}\n\n`);
        else res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'S1' }).end(body);
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const conn = new McpConnection('h', { url });
    await conn.connect();
    const t = toTool(conn, conn.tools[0]!);
    assert.equal(await t.run({}, { cwd: '.', agentId: 't', setTodos() {}, setPlan() {}, requestStop() {} }), 'pong');
    assert.ok(seen.includes('tools/list:S1') && seen.includes('tools/call:S1'), seen.join(','));
    server.close();
  });

  it('connectMcp: loads project .mcp.json when trusted, expands env, survives a broken server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moo-mcp-'));
    process.env.FAKE_PATH = fake;
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { good: { command: process.execPath, args: ['${FAKE_PATH}'] }, bad: { command: 'definitely-not-a-binary-xyz' } } }),
    );
    const ui = new UI();
    ui.ask = async () => 'y';
    const mgr = await connectMcp(dir, ui);
    assert.deepEqual(mgr.status.map((s) => [s.name, s.ok]).sort(), [['bad', false], ['good', true]]);
    assert.equal(mgr.tools.length, 2);
    mgr.closeAll();

    const ui2 = new UI();
    ui2.ask = async () => { throw new Error('should not prompt again once trusted'); };
    const again = await connectMcp(dir, ui2);
    assert.equal(again.tools.length, 2);
    again.closeAll();

    const denied = new UI();
    denied.ask = async () => 'n';
    const dir2 = mkdtempSync(join(tmpdir(), 'moo-mcp2-'));
    writeFileSync(join(dir2, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: process.execPath, args: [fake] } } }));
    assert.equal((await connectMcp(dir2, denied)).tools.length, 0);
  });
});
