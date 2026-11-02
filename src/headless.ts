import { Agent } from './agent.ts';
import { Checkpoints } from './checkpoint.ts';
import { connectMcp } from './mcp.ts';
import { MODES, Permissions, type Mode } from './permissions.ts';
import { buildSystem } from './prompt.ts';
import { createProvider, loadConfig } from './providers/index.ts';
import { Session } from './session.ts';
import { baseTools } from './tools/index.ts';
import { makeParallelTool, makeTaskTool, type Runtime } from './tools/subagents.ts';
import { Tracer } from './trace.ts';
import type { Tool } from './types.ts';
import { UI } from './ui.ts';
import { detectVerifyCommands, verifyLoop } from './verify.ts';

export interface HeadlessOptions {
  prompt: string;
  provider?: string;
  model?: string;
  mode?: Mode;
  format: 'text' | 'json';
  verify: boolean;
  cont: boolean;
}

/**
 * Read piped stdin (`cat log | moo -p "explain"`). A harness may leave stdin open without ever
 * writing or closing it, so if nothing at all arrives within `idleMs` we assume there is no input
 * instead of hanging; once data starts flowing we read until EOF.
 */
async function readStdin(idleMs = 1500): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let s = '';
    let started = false;
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      resolve(s);
    };
    const timer = setTimeout(() => !started && done(), idleMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      started = true;
      s += d;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/**
 * Non-interactive run for scripts and CI:  moo -p "fix the failing test" --mode auto-edit
 *  - stdout carries ONLY the result (text, or one JSON object); all progress goes to stderr
 *  - nothing can prompt, so un-approved mutating tools are denied (choose --mode auto-edit|yolo)
 *  - exit code: 0 success, 1 error, 2 verification failed (with --verify)
 */
export async function runHeadless(o: HeadlessOptions): Promise<number> {
  // Route all UI output to stderr so stdout stays machine-readable.
  const realOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...rest: any[]) => process.stderr.write(chunk, ...rest)) as typeof process.stdout.write;
  const emit = (s: string) => realOut(s);

  const started = Date.now();
  const fail = (msg: string, session?: string) => {
    if (o.format === 'json') emit(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: msg, session_id: session }) + '\n');
    else console.error(`Error: ${msg}`);
    return 1;
  };

  if (o.mode && !MODES.includes(o.mode)) return fail(`Unknown mode ${o.mode}. Choose: ${MODES.join(', ')}`);
  const cfg = loadConfig({ provider: o.provider, model: o.model });
  if (!cfg.provider || !cfg.model) {
    return fail('Not configured. Run `moo` once interactively, or set ANTHROPIC_API_KEY / OPENAI_API_KEY and MOO_MODEL (or --model).');
  }
  let provider;
  try {
    provider = createProvider(cfg);
  } catch (e: any) {
    return fail(e.message);
  }
  const model = cfg.model;
  const cwd = process.cwd();

  const stdin = await readStdin();
  const prompt = stdin ? `${o.prompt}\n\n<stdin>\n${stdin}\n</stdin>` : o.prompt;
  if (!prompt.trim()) return fail('Empty prompt. Usage: moo -p "<prompt>"');

  const ui = new UI(); // no readline attached → ask() answers "no"
  const resumed = o.cont ? Session.latest(cwd) : null;
  const session = new Session(cwd, provider.name, model, resumed?.id);
  const tracer = new Tracer(session.dir);
  const checkpoints = new Checkpoints(cwd, session.dir);
  if (resumed) checkpoints.restoreList(resumed.checkpoints);
  await checkpoints.init();

  const mode = o.mode ?? 'default';
  if (mode === 'default') ui.warn('headless default mode cannot ask for approval, so edits and shell commands will be denied; use --mode auto-edit or yolo');
  const permissions = new Permissions(mode, async () => 'n');

  const rt: Runtime = { provider, model, tracer, ui, cwd };
  const mcp = process.env.MOO_NO_MCP ? { tools: [] as Tool[], closeAll() {} } : await connectMcp(cwd, ui);
  const agent = new Agent({
    id: 'main',
    provider,
    model,
    cwd,
    tools: [...baseTools(), makeTaskTool(rt), makeParallelTool(rt), ...mcp.tools],
    permissions,
    tracer,
    ui,
    system: await buildSystem({ cwd }),
  });
  if (resumed) agent.messages = resumed.messages;

  let code = 0;
  let result = '';
  let verification: { passed: boolean; rounds: number; commands: string[] } | undefined;
  process.on('SIGINT', () => agent.interrupt());
  try {
    const cp = await checkpoints.create(prompt.replace(/\s+/g, ' ').slice(0, 60), agent.messages);
    if (cp) tracer.emit({ type: 'checkpoint', agent: 'main', ts: Date.now(), n: cp.n, label: cp.label });
    result = await agent.run(prompt);
    if (o.verify) {
      const cmds = detectVerifyCommands(cwd);
      if (cmds.length) {
        const rep = await verifyLoop(agent, cmds, ui);
        verification = { passed: rep.passed, rounds: rep.rounds, commands: cmds };
        if (!rep.passed) code = 2;
      }
    }
  } catch (e: any) {
    mcp.closeAll();
    return fail(e?.message ?? String(e), session.id);
  }
  session.save(agent.messages, checkpoints.list, agent.model);
  mcp.closeAll();

  const s = tracer.stats();
  if (o.format === 'json') {
    emit(
      JSON.stringify({
        type: 'result',
        subtype: code === 0 ? 'success' : 'verification_failed',
        is_error: code !== 0,
        result,
        session_id: session.id,
        duration_ms: Date.now() - started,
        num_llm_calls: s.llmCalls,
        num_tool_calls: s.toolCalls,
        usage: { input_tokens: s.inputTokens, output_tokens: s.outputTokens },
        ...(verification ? { verification } : {}),
      }) + '\n',
    );
  } else {
    emit(result.endsWith('\n') ? result : result + '\n');
  }
  return code;
}
