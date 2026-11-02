#!/usr/bin/env node
import { exec } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Agent } from './agent.ts';
import { Checkpoints } from './checkpoint.ts';
import { MODES, Permissions, type Mode } from './permissions.ts';
import { buildSystem } from './prompt.ts';
import { createProvider, loadConfig } from './providers/index.ts';
import { runHeadless } from './headless.ts';
import { connectMcp } from './mcp.ts';
import { playIntro } from './spinner.ts';
import { Session } from './session.ts';
import { gatedOutput, needsSetup, runSetup } from './setup.ts';
import { submitPlanTool } from './tools/meta.ts';
import { baseTools, readOnlyTools } from './tools/index.ts';
import { makeParallelTool, makeTaskTool, type Runtime } from './tools/subagents.ts';
import { Tracer } from './trace.ts';
import type { Plan, Provider, Tool } from './types.ts';
import { UI, c } from './ui.ts';
import { detectVerifyCommands, runVerify, verifyLoop } from './verify.ts';

const HELP = `${c.bold('MOO')} — coding agent

${c.bold('Usage')}  moo [options] [initial prompt]
  --provider anthropic|openai   --model <id>   --mode default|auto-edit|yolo|plan
  -c, --continue                resume the latest session in this directory
  -p, --print                   headless: run the prompt, print only the result to stdout, exit
      --output-format text|json   (with -p)   --verify  run tests/lint after and exit 2 on failure
  -h, --help

${c.bold('Slash commands')}
  /plan <goal>        read-only planning → approval → execute → auto-verify loop
  /checkpoints        list time-travel checkpoints (one per prompt)
  /rewind [n] [code|chat|both]   restore files and/or conversation to checkpoint n
  /diff [n]           what changed since checkpoint n (default: latest)
  /verify [show|set <cmd;;cmd>|auto on|off|run]   configure/run the verification commands
  /trace [open]       export the execution timeline as HTML
  /mcp                list MCP servers and their tools (config: ~/.moo/mcp.json, ./.mcp.json)
  /setup              re-enter provider, base URL, API key and model
  /mode [name]        permission mode      /model [id]   switch model
  /compact            summarize history    /cost         token usage
  /todos  /clear  /help  /exit
  Ctrl+C interrupts a running turn. End a line with \\ for multi-line input.`;

function parseArgs(argv: string[]) {
  const a: { provider?: string; model?: string; mode?: Mode; cont: boolean; help: boolean; prompt: string; print: boolean; format: 'text' | 'json'; verify: boolean } = {
    print: false,
    format: 'text',
    verify: false,
    cont: false,
    help: false,
    prompt: '',
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--provider') a.provider = argv[++i];
    else if (v === '--model') a.model = argv[++i];
    else if (v === '--mode') a.mode = argv[++i] as Mode;
    else if (v === '-c' || v === '--continue') a.cont = true;
    else if (v === '-p' || v === '--print') a.print = true;
    else if (v === '--output-format') a.format = argv[++i] === 'json' ? 'json' : 'text';
    else if (v === '--verify') a.verify = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else rest.push(v);
  }
  a.prompt = rest.join(' ');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  if (args.print) {
    process.exitCode = await runHeadless({ prompt: args.prompt, provider: args.provider, model: args.model, mode: args.mode, format: args.format, verify: args.verify, cont: args.cont });
    return;
  }
  if (args.mode && !MODES.includes(args.mode)) {
    console.error(`Unknown mode ${args.mode}. Choose: ${MODES.join(', ')}`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const ui = new UI();
  const rl = createInterface({ input: process.stdin, output: gatedOutput, terminal: !!process.stdin.isTTY });
  ui.rl = rl;

  // First run (or missing key/model): interactive setup of provider, URL, API key and model.
  let cfg = loadConfig(args);
  if (needsSetup(cfg)) {
    if (!process.stdin.isTTY) {
      console.error(c.red('Not configured. Run `moo` in an interactive terminal to set up, or set ANTHROPIC_API_KEY / OPENAI_API_KEY and MOO_MODEL.'));
      process.exit(1);
    }
    cfg = await runSetup(rl, cfg);
  }
  let provider: Provider;
  try {
    provider = createProvider(cfg);
  } catch (e: any) {
    console.error(c.red(e.message));
    process.exit(1);
  }
  const model = cfg.model!;

  // ---- session / checkpoints ----
  const resumed = args.cont ? Session.latest(cwd) : null;
  const session = new Session(cwd, provider.name, model, resumed?.id);
  const tracer = new Tracer(session.dir);
  const checkpoints = new Checkpoints(cwd, session.dir);
  const cpProblem = await checkpoints.init();
  if (cpProblem) ui.warn(`Checkpoints disabled: ${cpProblem}`);
  if (resumed) checkpoints.restoreList(resumed.checkpoints);

  // ---- agent wiring ----
  const rt: Runtime = { provider, model, tracer, ui, cwd };
  const permissions = new Permissions(args.mode ?? 'default', (q) => ui.ask(q));
  let userMode: Mode = permissions.mode === 'plan' ? 'default' : permissions.mode;
  const mcp = process.env.MOO_NO_MCP ? { tools: [] as Tool[], status: [], closeAll() {} } : await connectMcp(cwd, ui);
  process.on('exit', () => mcp.closeAll());
  const normalTools: Tool[] = [...baseTools(), makeTaskTool(rt), makeParallelTool(rt), ...mcp.tools];
  const planTools: Tool[] = [...readOnlyTools(), makeTaskTool(rt), submitPlanTool, ...mcp.tools.filter((t) => t.readOnly)];

  const agent = new Agent({
    id: 'main',
    provider,
    model,
    cwd,
    tools: normalTools,
    permissions,
    tracer,
    ui,
    system: await buildSystem({ cwd }),
  });
  if (resumed) agent.messages = resumed.messages;

  let verifyCmds: string[] | null = null; // null = auto-detect
  let autoVerify = false;
  const getVerify = () => verifyCmds ?? detectVerifyCommands(cwd);
  let lastCtrlC = 0;

  const save = () => session.save(agent.messages, checkpoints.list, agent.model);

  const snapshot = async (label: string) => {
    const cp = await checkpoints.create(label, agent.messages);
    if (cp) tracer.emit({ type: 'checkpoint', agent: 'main', ts: Date.now(), n: cp.n, label });
  };

  // ---- a normal turn: checkpoint → run → optional auto-verify ----
  async function turn(prompt: string) {
    await snapshot(prompt.replace(/\s+/g, ' ').slice(0, 60));
    agent.dirty = false;
    await agent.run(prompt);
    ui.line();
    if (autoVerify && agent.dirty) {
      const cmds = getVerify();
      if (cmds.length) {
        const rep = await verifyLoop(agent, cmds, ui);
        ui.line(rep.passed ? c.green('Verification passed.') : c.red('Verification still failing after repair attempts.'));
      }
    }
    save();
  }

  // ---- /plan: plan (read-only) → approve → execute → verify loop → report ----
  async function planFlow(goal: string) {
    await snapshot(`plan: ${goal}`.slice(0, 60));
    let approved: Plan | null = null;
    let prompt =
      `[PLAN MODE — read-only] Goal: ${goal}\n\nExplore the codebase with the read-only tools, then call submit_plan with a concrete step list and the verify_commands that prove it works. Do not modify files.`;
    for (let round = 0; round < 6 && !approved; round++) {
      permissions.mode = 'plan';
      agent.tools = planTools;
      agent.plan = null;
      try {
        await agent.run(prompt);
      } finally {
        permissions.mode = userMode;
        agent.tools = normalTools;
      }
      const plan = agent.plan as Plan | null;
      if (!plan) {
        ui.warn('The agent did not submit a plan.');
        return;
      }
      tracer.emit({ type: 'plan', agent: 'main', ts: Date.now(), label: plan.summary, detail: JSON.stringify(plan) });
      ui.line();
      ui.line(c.bold('Plan: ') + plan.summary);
      plan.steps.forEach((s, i) => ui.line(`  ${i + 1}. ${c.bold(s.title)}${s.detail ? c.dim(' — ' + s.detail) : ''}`));
      if (plan.verify_commands?.length) ui.line(c.dim('  verify: ' + plan.verify_commands.join(' && ')));
      const ans = (await ui.ask(`\n[a]pprove / approve + [e]dits auto / [r]eject / or type feedback to revise: `)).trim();
      const low = ans.toLowerCase();
      if (low === 'r' || low === 'reject') return ui.info('Plan rejected.');
      if (low === 'a' || low === 'approve' || low === 'e' || low === '') {
        if (low === 'e' && userMode === 'default') userMode = 'auto-edit';
        approved = plan;
      } else {
        prompt = `[PLAN MODE — read-only] The user wants changes to the plan: ${ans}\nRevise and call submit_plan again.`;
      }
    }
    if (!approved) return;

    permissions.mode = userMode;
    agent.todos = approved.steps.map((s, i) => ({ content: s.title, status: i === 0 ? 'in_progress' : 'pending' }));
    agent.dirty = false;
    await agent.run(
      `The user approved your plan. Execute it now, step by step, keeping the todo list updated with todo_write.\n\nPlan: ${approved.summary}\n${approved.steps.map((s, i) => `${i + 1}. ${s.title}${s.detail ? ': ' + s.detail : ''}`).join('\n')}`,
    );
    ui.line();

    // verification closed loop
    const cmds = approved.verify_commands?.length ? approved.verify_commands : getVerify();
    let report = 'No verification commands were found or provided.';
    if (cmds.length) {
      ui.line(c.bold('Verifying…'));
      const rep = await verifyLoop(agent, cmds, ui);
      report = rep.passed
        ? `PASSED${rep.rounds ? ` after ${rep.rounds} automatic repair round(s)` : ' on first run'}`
        : `FAILED after ${rep.rounds} repair rounds: ${rep.last.find((r) => r.code !== 0)?.cmd}`;
    }
    const cpN = checkpoints.list.findLast((x) => x.label.startsWith('plan:'))?.n;
    const stat = cpN ? await checkpoints.diffSince(cpN).catch(() => '') : '';
    ui.line();
    ui.line(c.bold('── Report ──'));
    ui.line(`Plan: ${approved.summary}`);
    ui.line(`Verification: ${report.startsWith('PASSED') ? c.green(report) : c.red(report)}`);
    if (stat) ui.line(c.dim(stat));
    if (cpN) ui.line(c.dim(`Undo everything with /rewind ${cpN}`));
    save();
  }

  // ---- slash commands ----
  async function slash(line: string): Promise<boolean> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'help':
        ui.line(HELP);
        break;
      case 'exit':
      case 'quit':
        return true;
      case 'clear':
        agent.messages = [];
        agent.todos = [];
        ui.ok('Conversation cleared (file checkpoints kept).');
        break;
      case 'plan':
        if (!arg) ui.warn('Usage: /plan <goal>');
        else await planFlow(arg);
        break;
      case 'checkpoints':
      case 'cp':
        if (!checkpoints.enabled) ui.warn('Checkpoints are disabled in this directory.');
        else if (!checkpoints.list.length) ui.info('No checkpoints yet — one is created before each prompt.');
        else
          for (const cp of checkpoints.list)
            ui.line(`  ${c.cyan('#' + cp.n)} ${new Date(cp.time).toLocaleTimeString()}  ${cp.label}`);
        break;
      case 'rewind': {
        const [nStr, what = 'both'] = arg.split(/\s+/);
        const n = Number(nStr);
        if (!nStr || !Number.isInteger(n)) return ui.warn('Usage: /rewind <n> [code|chat|both]   (see /checkpoints)'), false;
        if (!['code', 'chat', 'both'].includes(what)) return ui.warn('Second argument must be code, chat or both.'), false;
        try {
          if (what !== 'chat') {
            await checkpoints.restoreCode(n, agent.messages);
            ui.ok(`Files restored to checkpoint #${n}. (A safety checkpoint of the previous state was saved.)`);
          }
          if (what !== 'code') {
            const msgs = checkpoints.loadMessages(n);
            if (msgs) {
              agent.messages = msgs;
              ui.ok(`Conversation restored to before prompt #${n}.`);
            } else ui.warn('No saved conversation for that checkpoint.');
          }
          save();
        } catch (e: any) {
          ui.error(e.message);
        }
        break;
      }
      case 'diff': {
        const n = Number(arg) || checkpoints.list.at(-1)?.n;
        if (!n) return ui.warn('No checkpoint to diff against.'), false;
        try {
          ui.line((await checkpoints.diffSince(n, false)) || 'No changes.');
        } catch (e: any) {
          ui.error(e.message);
        }
        break;
      }
      case 'verify': {
        const [sub, ...r] = arg.split(/\s+/);
        if (!sub || sub === 'show') ui.line(`${autoVerify ? 'auto-verify ON' : 'auto-verify off'}\ncommands: ${getVerify().join('  &&  ') || '(none detected)'}${verifyCmds ? '' : c.dim(' [auto-detected]')}`);
        else if (sub === 'set') {
          verifyCmds = r.join(' ').split(';;').map((s) => s.trim()).filter(Boolean);
          ui.ok(`Verify commands: ${verifyCmds.join('  &&  ')}`);
        } else if (sub === 'auto') {
          autoVerify = r[0] !== 'off';
          ui.ok(`Auto-verify ${autoVerify ? 'on: after any turn that changes files, checks run and failures are fed back to the agent' : 'off'}`);
        } else if (sub === 'run') {
          const cmds = getVerify();
          if (!cmds.length) ui.warn('No verification commands. Use /verify set "npm test;;npm run lint"');
          else {
            const res = await runVerify(cmds, cwd, ui, tracer, 'main');
            const bad = res.find((x) => x.code !== 0);
            if (bad) ui.line(c.red(bad.output));
          }
        } else ui.warn('Usage: /verify [show | set <cmd;;cmd> | auto on|off | run]');
        break;
      }
      case 'trace': {
        const file = tracer.exportHtml();
        const s = tracer.stats();
        ui.ok(`Trace: ${file}`);
        ui.info(`${s.turns} turns, ${s.llmCalls} LLM calls, ${s.toolCalls} tool calls (${s.toolErrors} failed), ${s.inputTokens}/${s.outputTokens} tokens in/out`);
        if (arg === 'open') exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${file}"`);
        break;
      }
      case 'mode':
        if (!arg) ui.line(`mode: ${permissions.mode}  (${MODES.join(' | ')})`);
        else if (!MODES.includes(arg as Mode)) ui.warn(`Choose one of: ${MODES.join(', ')}`);
        else {
          permissions.mode = arg as Mode;
          userMode = arg as Mode;
          ui.ok(`Mode: ${arg}`);
        }
        break;
      case 'mcp':
        if (!mcp.status.length) ui.info('No MCP servers configured. Add them to ~/.moo/mcp.json or ./.mcp.json ({"mcpServers": {...}}).');
        for (const st of mcp.status) {
          ui.line(`  ${st.ok ? c.green('●') : c.red('●')} ${c.bold(st.name)} ${c.dim(st.transport)} ${st.ok ? c.dim(st.tools.length + ' tools') : c.red(st.error ?? '')}`);
          for (const t of st.tools) ui.line(c.dim(`      ${t}${mcp.tools.find((x) => x.spec.name === t)?.readOnly ? ' (read-only)' : ''}`));
        }
        break;
      case 'setup':
      case 'login': {
        const next = await runSetup(rl, loadConfig({}));
        provider = createProvider(next);
        rt.provider = provider;
        agent.provider = provider;
        rt.model = agent.model = next.model!;
        ui.ok(`Now using ${provider.name}/${agent.model}`);
        break;
      }
      case 'model':
        if (!arg) ui.line(`${provider.name}/${agent.model}`);
        else {
          agent.model = arg;
          rt.model = arg;
          ui.ok(`Model: ${arg}`);
        }
        break;
      case 'compact':
        await agent.compact();
        save();
        break;
      case 'cost':
        ui.line(`tokens in: ${agent.usage.input}  out: ${agent.usage.output}`);
        break;
      case 'todos':
        agent.todos.length ? ui.todos(agent.todos) : ui.info('No todos.');
        break;
      default:
        ui.warn(`Unknown command /${cmd}. Try /help`);
    }
    return false;
  }

  // ---- REPL ----
  rl.on('SIGINT', () => {
    if (agent.running) {
      agent.interrupt();
      return;
    }
    if (Date.now() - lastCtrlC < 1500) {
      rl.close();
      return;
    }
    lastCtrlC = Date.now();
    ui.line(c.dim('\n(press Ctrl+C again or type /exit to quit)'));
  });
  rl.on('close', () => {
    save();
    process.exit(0);
  });

  await playIntro([
    c.dim(`${provider.name}/${model} · ${permissions.mode} mode`),
    c.dim(`checkpoints ${checkpoints.enabled ? 'on' : 'off'} · session ${session.id}`),
    c.dim(cwd),
    c.dim('/help for commands · ctrl+c interrupts'),
  ]);
  if (mcp.status.length) ui.info(`MCP: ${mcp.status.map((x) => `${x.name} ${x.ok ? '✓ ' + x.tools.length : '✗'}`).join(', ')}  (/mcp for details)`);
  if (resumed) ui.info(`Resumed session with ${agent.messages.length} messages.`);

  const safe = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      ui.error(`Error: ${e?.message ?? e}`);
    }
  };

  if (args.prompt) await safe(() => turn(args.prompt));

  while (true) {
    let line: string;
    try {
      line = await rl.question(`\n${c.cyan(permissions.mode === 'default' ? 'moo' : `moo:${permissions.mode}`)} ${c.bold('❯')} `);
      while (line.endsWith('\\')) line = line.slice(0, -1) + '\n' + (await rl.question(c.dim('… ')));
    } catch {
      break; // stdin closed (Ctrl+D / EOF)
    }
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('/')) {
      let quit = false;
      await safe(async () => {
        quit = await slash(line);
      });
      if (quit) break;
    } else {
      await safe(() => turn(line));
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
