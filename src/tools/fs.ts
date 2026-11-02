import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Tool } from '../types.ts';

export function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Writes are confined to the working directory (a sub-agent's worktree, for sub-agents). */
function assertInside(cwd: string, abs: string) {
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to modify ${abs}: outside the working directory ${cwd}`);
  }
}

export const readFileTool: Tool = {
  spec: {
    name: 'read_file',
    description:
      'Read a text file. Returns lines prefixed with line numbers. Use offset/limit for large files (default: first 2000 lines).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or cwd-relative path' },
        offset: { type: 'integer', description: '1-based line to start from' },
        limit: { type: 'integer', description: 'Max lines to return' },
      },
      required: ['path'],
    },
  },
  readOnly: true,
  describe: (i) => i.path,
  async run(i, ctx) {
    const abs = resolvePath(ctx.cwd, i.path);
    const s = await stat(abs);
    if (s.isDirectory()) throw new Error(`${abs} is a directory; use glob or bash ls`);
    if (s.size > 5_000_000) throw new Error(`File is ${s.size} bytes; too large. Use grep or offset/limit via bash.`);
    const buf = await readFile(abs);
    if (buf.subarray(0, 4096).includes(0)) throw new Error('Binary file; not displayed.');
    const lines = buf.toString('utf8').split('\n');
    const start = Math.max(1, i.offset ?? 1);
    const limit = i.limit ?? 2000;
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((l, idx) => `${String(start + idx).padStart(5)}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
    const more = start - 1 + limit < lines.length ? `\n[… ${lines.length - (start - 1 + limit)} more lines; use offset=${start + limit}]` : '';
    return body + more;
  },
};

export const writeFileTool: Tool = {
  spec: {
    name: 'write_file',
    description: 'Create a file or fully overwrite an existing one. Prefer edit_file for modifying existing files.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  readOnly: false,
  kind: 'edit',
  describe: (i) => `${i.path} (${String(i.content ?? '').split('\n').length} lines)`,
  async run(i, ctx) {
    const abs = resolvePath(ctx.cwd, i.path);
    assertInside(ctx.cwd, abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, i.content);
    return `Wrote ${abs}`;
  },
};

export const editFileTool: Tool = {
  spec: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  readOnly: false,
  kind: 'edit',
  describe: (i) => i.path,
  async run(i, ctx) {
    const abs = resolvePath(ctx.cwd, i.path);
    assertInside(ctx.cwd, abs);
    if (i.old_string === i.new_string) throw new Error('old_string and new_string are identical');
    const text = await readFile(abs, 'utf8');
    const count = i.old_string === '' ? 0 : text.split(i.old_string).length - 1;
    if (count === 0) throw new Error('old_string not found in file. Re-read the file and match it exactly.');
    if (count > 1 && !i.replace_all) {
      throw new Error(`old_string occurs ${count} times; add more context to make it unique or set replace_all.`);
    }
    const next = i.replace_all ? text.split(i.old_string).join(i.new_string) : text.replace(i.old_string, () => i.new_string);
    await writeFile(abs, next);
    return `Edited ${abs} (${i.replace_all ? count : 1} replacement${count > 1 && i.replace_all ? 's' : ''})`;
  },
};
