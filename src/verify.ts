import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from './agent.ts';
import type { Tracer } from './trace.ts';
import type { UI } from './ui.ts';
import { c } from './ui.ts';
import { runShell, truncate } from './util.ts';

export interface VerifyResult {
  cmd: string;
  code: number | null;
  output: string;
  ms: number;
}

/** Guess the project's verification commands (tests, type-check, lint, build). */
export function detectVerifyCommands(cwd: string): string[] {
  const has = (f: string) => existsSync(join(cwd, f));
  const cmds: string[] = [];
  if (has('package.json')) {
    try {
      const scripts = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts ?? {};
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
      for (const name of ['typecheck', 'check', 'lint', 'test', 'build']) {
        const body = String(scripts[name] ?? '');
        if (body && !/no test specified/.test(body)) cmds.push(name === 'test' ? `${pm} test` : `${pm} run ${name}`);
      }
      // keep it fast: build only if nothing else exists
      if (cmds.length > 1) return cmds.filter((x) => !x.endsWith('run build'));
    } catch {}
  }
  if (has('go.mod')) cmds.push('go build ./... && go test ./...');
  if (has('Cargo.toml')) cmds.push('cargo test');
  if (has('pytest.ini') || has('tox.ini') || has('tests') || (has('pyproject.toml') && /pytest/.test(readFileSync(join(cwd, 'pyproject.toml'), 'utf8')))) {
    cmds.push('python -m pytest -x -q');
  }
  return cmds;
}

export async function runVerify(cmds: string[], cwd: string, ui: UI, tracer: Tracer, agentId: string, signal?: AbortSignal): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const cmd of cmds) {
    ui.info(`verify: ${cmd}`);
    const ts = Date.now();
    ui.busy(true);
    ui.status(`Running ${cmd.slice(0, 40)}`);
    const r = await runShell(cmd, { cwd, timeoutMs: 300_000, signal }).finally(() => ui.busy(false));
    const res: VerifyResult = { cmd, code: r.timedOut ? -1 : r.code, output: truncate(r.output.trim(), 6000), ms: Date.now() - ts };
    results.push(res);
    tracer.emit({ type: 'verify', agent: agentId, ts, dur: res.ms, cmd, code: res.code, error: res.code !== 0, output: res.output });
    ui.line(`  ${res.code === 0 ? c.green('✓') : c.red('✗')} ${cmd} ${c.dim(`(${(res.ms / 1000).toFixed(1)}s)`)}`);
    if (res.code !== 0) break; // later checks usually depend on earlier ones
  }
  return results;
}

export interface VerifyLoopReport {
  passed: boolean;
  rounds: number;
  last: VerifyResult[];
}

/**
 * Verify → feed failures back to the agent → re-verify, up to maxRounds repairs.
 * Returns whether everything finally passed.
 */
export async function verifyLoop(agent: Agent, cmds: string[], ui: UI, maxRounds = 3): Promise<VerifyLoopReport> {
  let last: VerifyResult[] = [];
  for (let round = 0; round <= maxRounds; round++) {
    last = await runVerify(cmds, agent.cwd, ui, agent.tracer, agent.id);
    const failed = last.find((r) => r.code !== 0);
    if (!failed) return { passed: true, rounds: round, last };
    if (round === maxRounds) break;
    ui.warn(`Verification failed (${failed.cmd}); asking agent to fix (attempt ${round + 1}/${maxRounds})…`);
    await agent.run(
      `Verification failed.\nCommand: ${failed.cmd}\nExit code: ${failed.code}\nOutput:\n${failed.output}\n\nDiagnose the root cause and fix it. Do not weaken or delete tests just to make them pass. Stop when you believe it is fixed; I will re-run the checks.`,
    );
  }
  return { passed: false, rounds: maxRounds, last };
}
