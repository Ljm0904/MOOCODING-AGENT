import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git, MOO_HOME } from './util.ts';

const MEMORY_FILES = ['MOO.md', 'CLAUDE.md', 'AGENTS.md'];

function loadMemory(cwd: string): string {
  const parts: string[] = [];
  const global = join(MOO_HOME, 'MOO.md');
  if (existsSync(global)) parts.push(`# User memory (${global})\n${readFileSync(global, 'utf8')}`);
  for (const f of MEMORY_FILES) {
    const p = join(cwd, f);
    if (existsSync(p)) {
      parts.push(`# Project memory (${f})\n${readFileSync(p, 'utf8')}`);
      break;
    }
  }
  return parts.join('\n\n');
}

async function gitSummary(cwd: string): Promise<string> {
  try {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).trim();
    const status = (await git(['status', '--short'], { cwd })).trim().split('\n').slice(0, 20).join('\n');
    return `Git branch: ${branch}\nGit status:\n${status || '(clean)'}`;
  } catch {
    return 'Not a git repository.';
  }
}

export interface PromptOpts {
  cwd: string;
  role?: 'main' | 'explorer' | 'worker';
  extra?: string;
}

export async function buildSystem(o: PromptOpts): Promise<string> {
  const role = o.role ?? 'main';
  const intro =
    role === 'explorer'
      ? 'You are a read-only research sub-agent. Search and read code to answer the question, then reply with a concise, factual report including file paths and line numbers. You cannot modify anything.'
      : role === 'worker'
        ? 'You are a sub-agent working on ONE task in your own isolated git worktree, in parallel with other agents working on other tasks. Stay strictly within your task scope and do not touch unrelated files. Dependencies installed in the main checkout (e.g. node_modules) may be absent in your worktree. When finished, reply with a short summary of what you changed. Your changes are committed and merged automatically; do not run git commit/merge yourself.'
        : 'You are MOO, an interactive coding agent running in the user\'s terminal. You help with software engineering tasks by reading, searching, editing code and running commands using the provided tools.';

  const guidelines = `
# How to work
- Read code before changing it. Use glob/grep to locate things; do not guess paths.
- Make the smallest change that solves the problem. Match the existing style and conventions of the codebase.
- Prefer edit_file over write_file for existing files. Never create documentation files unless asked.
- After changes, verify them: run the project's tests / type-check / build when they exist.
- For multi-step work keep a todo list with todo_write.
- Independent read-only calls can be issued together in one response; they run in parallel.
- If a tool call is denied by the user, do not retry the same action; adapt or ask.
- Be concise. Reference code as path:line. No emojis unless asked.
${role === 'main' ? '- Use the task tool for broad codebase research that would flood your context.\n- Use parallel_tasks only when work splits into clearly independent pieces touching different files.' : ''}`;

  const env = `
# Environment
Working directory: ${o.cwd}
Platform: ${process.platform}
Date: ${new Date().toISOString().slice(0, 10)}
Home: ${homedir()}
${await gitSummary(o.cwd)}`;

  const memory = role === 'main' ? loadMemory(o.cwd) : '';
  return [intro, guidelines, env, memory, o.extra ?? ''].filter(Boolean).join('\n');
}
