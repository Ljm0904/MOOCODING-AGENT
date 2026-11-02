import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MOO_HOME = process.env.MOO_HOME ?? join(homedir(), '.moo');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';

export function truncate(s: string, max = 30000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.5);
  const tail = Math.floor(max * 0.33);
  return `${s.slice(0, head)}\n\n... [${s.length - head - tail} chars truncated] ...\n\n${s.slice(-tail)}`;
}

export interface GitOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** Run git and return stdout. Throws with stderr on non-zero exit. */
export function git(args: string[], opts: GitOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 128 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || stdout || err.message).toString().trim()));
        else resolve(stdout.toString());
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Run a shell command with timeout + abort support, killing the whole process group. */
export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd: opts.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const max = opts.maxBytes ?? 2_000_000;
    let out = '';
    let timedOut = false;
    const onData = (d: Buffer) => {
      if (out.length < max) out += d.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 120_000);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: out, timedOut });
    };
    child.on('error', (e) => {
      out += String(e);
      done(-1);
    });
    child.on('close', done);
  });
}

/** Convert a glob (supports **, *, ?, {a,b}) into a RegExp matching a relative posix path. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  let inBrace = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inBrace++;
      re += '(?:';
    } else if (c === '}' && inBrace) {
      inBrace--;
      re += ')';
    } else if (c === ',' && inBrace) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
