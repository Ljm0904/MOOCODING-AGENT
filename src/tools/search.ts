import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Tool } from '../types.ts';
import { globToRegex, runShell } from '../util.ts';
import { resolvePath } from './fs.ts';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'target', '.moo']);

async function walk(root: string, visit: (rel: string) => void, limit = 50_000) {
  let seen = 0;
  const rec = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen > limit) return;
      if (e.isDirectory()) {
        if (!IGNORED.has(e.name)) await rec(join(dir, e.name));
      } else {
        seen++;
        visit(relative(root, join(dir, e.name)).split('\\').join('/'));
      }
    }
  };
  await rec(root);
}

export const globTool: Tool = {
  spec: {
    name: 'glob',
    description:
      'Find files by glob pattern (supports **, *, ?, {a,b}). A pattern without "/" matches the file name anywhere. Skips node_modules/.git/dist. Returns up to 500 paths, newest first.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search (default cwd)' } },
      required: ['pattern'],
    },
  },
  readOnly: true,
  describe: (i) => i.pattern,
  async run(i, ctx) {
    const root = resolvePath(ctx.cwd, i.path ?? '.');
    const pat = String(i.pattern);
    const re = globToRegex(pat.includes('/') ? pat : `**/${pat}`);
    const hits: string[] = [];
    await walk(root, (rel) => {
      if (re.test(rel)) hits.push(rel);
    });
    const withTime = await Promise.all(
      hits.slice(0, 2000).map(async (h) => ({ h, t: (await stat(join(root, h)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    withTime.sort((a, b) => b.t - a.t);
    const out = withTime.slice(0, 500).map((x) => x.h);
    return out.length ? out.join('\n') + (hits.length > 500 ? `\n[… ${hits.length - 500} more]` : '') : 'No files matched.';
  },
};

let rgAvailable: boolean | undefined;

export const grepTool: Tool = {
  spec: {
    name: 'grep',
    description:
      'Search file contents with a regular expression (ripgrep if installed, else grep -E). Returns file:line:text, max 200 lines.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'File or directory (default cwd)' },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  readOnly: true,
  describe: (i) => `${i.pattern}${i.path ? ' in ' + i.path : ''}`,
  async run(i, ctx) {
    const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    if (rgAvailable === undefined) rgAvailable = (await runShell('command -v rg', { cwd: ctx.cwd })).code === 0;
    const target = q(i.path ?? '.');
    const cmd = rgAvailable
      ? `rg -n --no-heading --color never ${i.ignore_case ? '-i ' : ''}${i.glob ? `-g ${q(i.glob)} ` : ''}-e ${q(i.pattern)} ${target}`
      : `grep -rnE ${i.ignore_case ? '-i ' : ''}${i.glob ? `--include=${q(i.glob)} ` : ''}--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -e ${q(i.pattern)} ${target}`;
    const res = await runShell(`${cmd} | head -n 200`, { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 30_000 });
    return res.output.trim() || 'No matches.';
  },
};
