import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TraceEvent {
  type: 'turn' | 'llm' | 'tool' | 'verify' | 'checkpoint' | 'compact' | 'subagent' | 'plan';
  agent: string;
  ts: number; // start, epoch ms
  dur?: number; // ms
  [k: string]: unknown;
}

const clip = (v: unknown, n = 4000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + `… [+${s.length - n}]` : s;
};

/** Append-only JSONL event log + self-contained HTML timeline export. */
export class Tracer {
  events: TraceEvent[] = [];
  private file: string;
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'trace.jsonl');
  }

  emit(ev: TraceEvent) {
    for (const k of ['output', 'input', 'prompt', 'detail']) {
      if (k in ev && typeof ev[k] !== 'number') ev[k] = clip(ev[k]); // llm events carry token counts in input/output
    }
    this.events.push(ev);
    try {
      appendFileSync(this.file, JSON.stringify(ev) + '\n');
    } catch {}
  }

  /** Time an async operation and emit one span event when it finishes. */
  async span<T>(base: Omit<TraceEvent, 'ts' | 'dur'>, fn: () => Promise<T>, extra?: (r: T) => Record<string, unknown>): Promise<T> {
    const ts = Date.now();
    try {
      const r = await fn();
      this.emit({ ...base, ts, dur: Date.now() - ts, ...(extra ? extra(r) : {}) } as unknown as TraceEvent);
      return r;
    } catch (e: any) {
      this.emit({ ...base, ts, dur: Date.now() - ts, error: true, output: String(e?.message ?? e) } as unknown as TraceEvent);
      throw e;
    }
  }

  stats() {
    const llm = this.events.filter((e) => e.type === 'llm');
    const tools = this.events.filter((e) => e.type === 'tool');
    return {
      turns: this.events.filter((e) => e.type === 'turn').length,
      llmCalls: llm.length,
      toolCalls: tools.length,
      toolErrors: tools.filter((e) => e.error).length,
      inputTokens: llm.reduce((s, e) => s + ((e.input as number) || 0), 0),
      outputTokens: llm.reduce((s, e) => s + ((e.output as number) || 0), 0),
    };
  }

  exportHtml(): string {
    const tpl = readFileSync(new URL('./trace-template.html', import.meta.url), 'utf8');
    const data = JSON.stringify({ events: this.events, stats: this.stats(), generated: Date.now() }).replace(/</g, '\\u003c');
    const out = join(this.dir, 'trace.html');
    writeFileSync(out, tpl.replace('__DATA__', () => data));
    return out;
  }
}
