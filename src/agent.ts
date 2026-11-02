import type { Permissions } from './permissions.ts';
import type { Tracer } from './trace.ts';
import type { Block, Message, Plan, Provider, Todo, Tool, ToolContext, ToolResultBlock, ToolUseBlock } from './types.ts';
import type { UI } from './ui.ts';
import { truncate } from './util.ts';

export interface AgentOptions {
  id: string;
  provider: Provider;
  model: string;
  cwd: string;
  tools: Tool[];
  permissions: Permissions;
  tracer: Tracer;
  ui: UI;
  system: string;
  maxTurns?: number;
  /** Stream assistant text to the terminal as it arrives. */
  stream?: boolean;
  /** Compact the conversation when the last request exceeded this many input tokens. */
  contextLimit?: number;
}

export class Agent {
  id: string;
  provider: Provider;
  model: string;
  cwd: string;
  tools: Tool[];
  permissions: Permissions;
  tracer: Tracer;
  ui: UI;
  system: string;
  messages: Message[] = [];
  todos: Todo[] = [];
  plan: Plan | null = null;
  usage = { input: 0, output: 0 };
  /** Files touched via edit/write tools during the current run (for auto-verify). */
  dirty = false;

  private maxTurns: number;
  private stream: boolean;
  private contextLimit: number;
  private lastInput = 0;
  private stopRequested = false;
  private abort: AbortController | null = null;

  constructor(o: AgentOptions) {
    this.id = o.id;
    this.provider = o.provider;
    this.model = o.model;
    this.cwd = o.cwd;
    this.tools = o.tools;
    this.permissions = o.permissions;
    this.tracer = o.tracer;
    this.ui = o.ui;
    this.system = o.system;
    this.maxTurns = o.maxTurns ?? 60;
    this.stream = o.stream ?? true;
    this.contextLimit = o.contextLimit ?? Number(process.env.MOO_CTX_LIMIT ?? 120_000);
  }

  get running() {
    return this.abort !== null;
  }

  interrupt() {
    this.abort?.abort();
  }

  /** Append user content, merging into a trailing user message to keep roles alternating. */
  private pushUser(blocks: Block[]) {
    const last = this.messages.at(-1);
    if (last?.role === 'user') last.content.push(...blocks);
    else this.messages.push({ role: 'user', content: blocks });
  }

  private ctx(): ToolContext {
    return {
      cwd: this.cwd,
      signal: this.abort?.signal,
      agentId: this.id,
      setTodos: (t) => {
        this.todos = t;
        this.ui.todos(t);
      },
      setPlan: (p) => {
        this.plan = p;
      },
      requestStop: () => {
        this.stopRequested = true;
      },
    };
  }

  /** Run one user prompt to completion (until the model stops calling tools). Returns the final text. */
  async run(prompt: string): Promise<string> {
    if (this.abort) throw new Error('Agent is already running');
    this.abort = new AbortController();
    this.ui.busy(true);
    this.stopRequested = false;
    const signal = this.abort.signal;
    const turnStart = Date.now();
    let final = '';
    let interrupted = false;
    this.pushUser([{ type: 'text', text: prompt }]);

    try {
      for (let step = 0; step < this.maxTurns; step++) {
        if (this.lastInput > this.contextLimit) await this.compact();

        const t0 = Date.now();
        this.ui.status(null);
        const res = await this.provider.complete({
          model: this.model,
          system: this.system,
          messages: this.messages,
          tools: this.tools.map((t) => t.spec),
          maxTokens: 16000,
          signal,
          onText: this.stream ? (t) => this.ui.stream(t) : undefined,
        });
        this.lastInput = res.usage.input;
        this.usage.input += res.usage.input;
        this.usage.output += res.usage.output;
        this.tracer.emit({
          type: 'llm',
          agent: this.id,
          ts: t0,
          dur: Date.now() - t0,
          model: this.model,
          input: res.usage.input,
          output: res.usage.output,
          stop: res.stopReason,
        });

        this.messages.push({ role: 'assistant', content: res.content });
        const text = res.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as any).text as string)
          .join('');
        if (text) final = text;

        const uses = res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (uses.length === 0) {
          if (res.stopReason === 'max_tokens') {
            this.pushUser([{ type: 'text', text: 'Your response was cut off. Continue exactly where you left off.' }]);
            continue;
          }
          break;
        }

        const results = await this.execTools(uses, signal);
        this.messages.push({ role: 'user', content: results });
        if (signal.aborted) {
          interrupted = true;
          break;
        }
        if (this.stopRequested) break;
        if (step === this.maxTurns - 1) this.ui.warn(`Stopped after ${this.maxTurns} model calls.`);
      }
    } catch (e: any) {
      if (signal.aborted || e?.name === 'AbortError') interrupted = true;
      else throw e;
    } finally {
      this.abort = null;
      this.ui.busy(false);
      this.tracer.emit({
        type: 'turn',
        agent: this.id,
        ts: turnStart,
        dur: Date.now() - turnStart,
        prompt: prompt.slice(0, 300),
        interrupted,
      });
    }
    if (interrupted) {
      this.ui.warn('[interrupted]');
      return final || '[interrupted]';
    }
    return final;
  }

  private async execTools(uses: ToolUseBlock[], signal: AbortSignal): Promise<ToolResultBlock[]> {
    const lookup = (u: ToolUseBlock) => this.tools.find((t) => t.spec.name === u.name);
    const allReadOnly = uses.every((u) => lookup(u)?.readOnly);
    if (allReadOnly) return Promise.all(uses.map((u) => this.execOne(u, signal)));
    const out: ToolResultBlock[] = [];
    for (const u of uses) out.push(await this.execOne(u, signal)); // sequential: prompts + ordering
    return out;
  }

  private async execOne(u: ToolUseBlock, signal: AbortSignal): Promise<ToolResultBlock> {
    const tool = this.tools.find((t) => t.spec.name === u.name);
    const mk = (content: string, is_error = false): ToolResultBlock => ({
      type: 'tool_result',
      tool_use_id: u.id,
      content: truncate(content),
      ...(is_error ? { is_error: true } : {}),
    });
    if (!tool) return mk(`Unknown tool "${u.name}". Available: ${this.tools.map((t) => t.spec.name).join(', ')}`, true);
    if (signal.aborted) return mk('Interrupted before execution.', true);

    let desc = '';
    try {
      desc = tool.describe(u.input ?? {});
    } catch {}
    this.ui.toolCall(tool.spec.name, desc);
    this.ui.status(`Running ${tool.spec.name}`);

    const perm = await this.permissions.check(tool, u.input ?? {}, desc);
    if (!perm.ok) {
      this.ui.warn(`  ⎿ denied`);
      this.tracer.emit({ type: 'tool', agent: this.id, ts: Date.now(), dur: 0, name: tool.spec.name, desc, input: u.input, error: true, output: perm.reason });
      return mk(perm.reason, true);
    }

    const ts = Date.now();
    try {
      const out = await tool.run(u.input ?? {}, this.ctx());
      if (tool.kind === 'edit') this.dirty = true;
      this.tracer.emit({ type: 'tool', agent: this.id, ts, dur: Date.now() - ts, name: tool.spec.name, desc, input: u.input, output: out });
      this.ui.toolResult(out, false);
      return mk(out);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (tool.kind === 'exec' || tool.kind === 'edit') this.dirty = true;
      this.tracer.emit({ type: 'tool', agent: this.id, ts, dur: Date.now() - ts, name: tool.spec.name, desc, input: u.input, error: true, output: msg });
      this.ui.toolResult(msg, true);
      return mk(msg, true);
    }
  }

  /** Replace the history with a model-written summary. Always leaves a single valid user message. */
  async compact(): Promise<void> {
    if (this.messages.length < 2) return;
    const ts = Date.now();
    this.ui.info('Compacting conversation…');
    this.ui.status('Compacting conversation');
    const msgs: Message[] = JSON.parse(JSON.stringify(this.messages));
    const ask: Block = {
      type: 'text',
      text: 'Summarize the conversation so far so work can continue seamlessly in a fresh context. Include: the user\'s goals, key decisions, files read/changed (with paths), commands run and results, the current state, and the remaining TODOs. Be dense and factual. Do not call tools.',
    };
    const last = msgs.at(-1)!;
    if (last.role === 'user') last.content.push(ask);
    else msgs.push({ role: 'user', content: [ask] });
    const res = await this.provider.complete({
      model: this.model,
      system: 'You write precise working summaries of coding sessions.',
      messages: msgs,
      tools: [],
      maxTokens: 4000,
      signal: this.abort?.signal,
    });
    const summary = res.content.filter((b) => b.type === 'text').map((b) => (b as any).text).join('');
    this.messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: `[Summary of the conversation so far]\n${summary}\n\n[End of summary. Continue from here.]` }],
      },
    ];
    this.lastInput = 0;
    this.tracer.emit({ type: 'compact', agent: this.id, ts, dur: Date.now() - ts, label: 'compact', output: summary });
  }
}
