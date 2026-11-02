import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Agent } from '../agent.ts';
import { Permissions } from '../permissions.ts';
import { buildSystem } from '../prompt.ts';
import type { Tracer } from '../trace.ts';
import type { Provider, Tool } from '../types.ts';
import type { UI } from '../ui.ts';
import { MOO_HOME, git, sha, slug } from '../util.ts';
import { baseTools, readOnlyTools } from './index.ts';

/** Shared handles sub-agent tools need; `model` is mutable so /model applies to future sub-agents. */
export interface Runtime {
  provider: Provider;
  model: string;
  tracer: Tracer;
  ui: UI;
  cwd: string;
}

/** Read-only research sub-agent: keeps big exploration out of the main context. */
export function makeTaskTool(rt: Runtime): Tool {
  let counter = 0;
  return {
    spec: {
      name: 'task',
      description:
        'Delegate a read-only research question to a fresh sub-agent (it can read/glob/grep but not modify anything). Use for broad searches so the main context stays small. Returns its report.',
      input_schema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '3-5 word label' },
          prompt: { type: 'string', description: 'Full, self-contained question; the sub-agent has no other context' },
        },
        required: ['description', 'prompt'],
      },
    },
    readOnly: true,
    describe: (i) => i.description,
    async run(i, ctx) {
      const id = `explore-${++counter}`;
      const ui = rt.ui.child(`[${id}]`);
      const agent = new Agent({
        id,
        provider: rt.provider,
        model: rt.model,
        cwd: ctx.cwd,
        tools: readOnlyTools(),
        permissions: new Permissions('plan', async () => 'n'),
        tracer: rt.tracer,
        ui,
        system: await buildSystem({ cwd: ctx.cwd, role: 'explorer' }),
        maxTurns: 25,
        stream: false,
      });
      ctx.signal?.addEventListener('abort', () => agent.interrupt(), { once: true });
      const out = await agent.run(i.prompt);
      return out || '(sub-agent returned no text)';
    },
  };
}

interface WorkerResult {
  name: string;
  branch: string;
  wt: string;
  summary: string;
  committed: boolean;
  merged?: boolean;
  note?: string;
}

/**
 * Parallel workers, each in its own `git worktree` on its own branch. When all finish, branches are
 * merged back sequentially; a conflicting branch is left intact for the user instead of being forced.
 */
export function makeParallelTool(rt: Runtime): Tool {
  return {
    spec: {
      name: 'parallel_tasks',
      description:
        'Run 2-4 INDEPENDENT coding tasks concurrently, each by its own sub-agent in an isolated git worktree, then merge results back. Requires a git repo with at least one commit. Tasks must touch different files/areas; each prompt must be fully self-contained. Do not use for tasks that depend on each other.',
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short label, e.g. "add-auth-tests"' },
                prompt: { type: 'string', description: 'Complete instructions for this worker' },
              },
              required: ['name', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    readOnly: false,
    kind: 'exec',
    describe: (i) => (i.tasks ?? []).map((t: any) => t.name).join(', '),
    async run(i, ctx) {
      const tasks: { name: string; prompt: string }[] = (i.tasks ?? []).slice(0, 4);
      if (!tasks.length) throw new Error('No tasks given');
      let top: string;
      try {
        top = (await git(['rev-parse', '--show-toplevel'], { cwd: ctx.cwd })).trim();
        await git(['rev-parse', '--verify', 'HEAD'], { cwd: top });
      } catch {
        throw new Error('parallel_tasks needs a git repository with at least one commit. Run the tasks sequentially instead.');
      }
      const rel = relative(top, ctx.cwd);
      const runId = Date.now().toString(36);
      const base = join(MOO_HOME, 'worktrees', `${sha(top)}-${runId}`);
      await mkdir(base, { recursive: true });
      const dirty = (await git(['status', '--porcelain'], { cwd: top })).trim();
      const identity = await gitIdentityArgs(top);

      const results: WorkerResult[] = await Promise.all(
        tasks.map(async (t, idx): Promise<WorkerResult> => {
          const name = `${slug(t.name)}`;
          const branch = `moo/${runId}/${name}`;
          const wt = join(base, name);
          const r: WorkerResult = { name, branch, wt, summary: '', committed: false };
          try {
            await git(['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], { cwd: top });
            const id = `worker-${idx + 1}:${name}`;
            const agent = new Agent({
              id,
              provider: rt.provider,
              model: rt.model,
              cwd: join(wt, rel),
              tools: baseTools(),
              permissions: new Permissions('yolo', async () => 'n'),
              tracer: rt.tracer,
              ui: rt.ui.child(`[${name}]`),
              system: await buildSystem({ cwd: join(wt, rel), role: 'worker' }),
              maxTurns: 40,
              stream: false,
            });
            ctx.signal?.addEventListener('abort', () => agent.interrupt(), { once: true });
            rt.ui.info(`[${name}] started in ${wt}`);
            r.summary = (await agent.run(t.prompt)) || '(no summary)';
            await git(['add', '-A'], { cwd: wt });
            const changed = (await git(['status', '--porcelain'], { cwd: wt })).trim();
            if (changed) {
              await git([...identity, 'commit', '-q', '-m', `moo: ${t.name}`], { cwd: wt });
              r.committed = true;
            }
            rt.ui.ok(`[${name}] done${r.committed ? '' : ' (no changes)'}`);
          } catch (e: any) {
            r.note = `failed: ${e.message}`;
            rt.ui.error(`[${name}] ${r.note}`);
          }
          return r;
        }),
      );

      // Sequential merge back into the current branch.
      for (const r of results) {
        if (!r.committed) {
          await cleanup(top, r, true);
          continue;
        }
        try {
          await git([...identity, 'merge', '--no-ff', '-m', `Merge ${r.branch}`, r.branch], { cwd: top });
          r.merged = true;
          await cleanup(top, r, true);
        } catch (e: any) {
          await git(['merge', '--abort'], { cwd: top }).catch(() => {});
          r.merged = false;
          r.note = `merge failed (${String(e.message).split('\n')[0]}); branch and worktree kept`;
          rt.ui.warn(`[${r.name}] ${r.note}`);
        }
      }

      const lines = results.map((r) => {
        const status = r.merged ? 'merged' : r.committed ? 'NOT merged' : r.note ? 'failed' : 'no changes';
        return `## ${r.name} — ${status}${r.note ? ` (${r.note})` : ''}${!r.merged && r.committed ? `\nbranch: ${r.branch}\nworktree: ${r.wt}` : ''}\n${r.summary}`;
      });
      const head = dirty
        ? 'Note: the main working tree had uncommitted changes when workers started; workers saw only the committed HEAD.\n\n'
        : '';
      return head + lines.join('\n\n');
    },
  };
}

async function cleanup(top: string, r: WorkerResult, deleteBranch: boolean) {
  await git(['worktree', 'remove', '--force', r.wt], { cwd: top }).catch(() => {});
  if (deleteBranch) await git(['branch', '-D', r.branch], { cwd: top }).catch(() => {});
}

async function gitIdentityArgs(cwd: string): Promise<string[]> {
  const has = async (k: string) => (await git(['config', k], { cwd }).catch(() => '')).trim() !== '';
  return (await has('user.name')) && (await has('user.email')) ? [] : ['-c', 'user.name=moo', '-c', 'user.email=moo@localhost'];
}
