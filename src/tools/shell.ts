import type { Tool } from '../types.ts';
import { runShell, truncate } from '../util.ts';

// Hard block even in yolo mode.
const CATASTROPHIC = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\/\*|~\/\*)(\s|$)/,
  /:\(\)\s*\{.*\};\s*:/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b.*\bof=\/dev\/(sd|disk|nvme)/,
  />\s*\/dev\/(sd|disk|nvme)/,
];

export const bashTool: Tool = {
  spec: {
    name: 'bash',
    description:
      'Run a shell command in the working directory (bash -c). Output is combined stdout+stderr. Default timeout 120s. Do not run interactive or long-lived server commands in the foreground.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', description: 'Timeout in ms (max 600000)' },
      },
      required: ['command'],
    },
  },
  readOnly: false,
  kind: 'exec',
  describe: (i) => i.command,
  async run(i, ctx) {
    const cmd = String(i.command ?? '');
    if (CATASTROPHIC.some((r) => r.test(cmd))) throw new Error('Blocked: command looks destructive to the system.');
    const res = await runShell(cmd, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: Math.min(i.timeout_ms ?? 120_000, 600_000),
    });
    let out = truncate(res.output.trimEnd());
    if (res.timedOut) out += `\n[timed out]`;
    if (ctx.signal?.aborted) out += `\n[interrupted]`;
    if (res.code !== 0) {
      throw new Error(`${out}\n[exit code ${res.code}]`.trim());
    }
    return out || '(no output)';
  },
};
