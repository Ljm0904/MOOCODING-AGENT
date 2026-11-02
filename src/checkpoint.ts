import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message } from './types.ts';
import { MOO_HOME, git, sha } from './util.ts';

export interface Checkpoint {
  n: number;
  label: string;
  commit: string;
  time: number;
}

export type RestoreWhat = 'both' | 'code' | 'chat';

/**
 * Time-travel via a *shadow* git repository: GIT_DIR lives under ~/.moo, GIT_WORK_TREE is the
 * project. The user's own .git (history, index, branches) is never touched. Each checkpoint is a
 * commit of the full working tree plus a copy of the conversation at that moment.
 */
export class Checkpoints {
  enabled = false;
  list: Checkpoint[] = [];
  private gitDir: string;
  private cwd: string;
  private sessionDir: string;

  constructor(cwd: string, sessionDir: string) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.gitDir = join(MOO_HOME, 'shadow', sha(cwd));
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.cwd,
      GIT_AUTHOR_NAME: 'moo',
      GIT_AUTHOR_EMAIL: 'moo@localhost',
      GIT_COMMITTER_NAME: 'moo',
      GIT_COMMITTER_EMAIL: 'moo@localhost',
    };
  }

  private g(args: string[]) {
    return git(['-c', 'core.quotepath=off', '-c', 'gc.auto=0', '-c', 'core.autocrlf=false', ...args], { cwd: this.cwd, env: this.env() });
  }

  /** Returns a reason string if checkpoints are unavailable. */
  async init(): Promise<string | null> {
    if (this.cwd === '/' || this.cwd === homedir()) return 'refusing to snapshot your home or root directory';
    try {
      if (!existsSync(join(this.gitDir, 'HEAD'))) {
        mkdirSync(this.gitDir, { recursive: true });
        await this.g(['init', '-q']);
      }
      mkdirSync(join(this.gitDir, 'info'), { recursive: true });
      writeFileSync(
        join(this.gitDir, 'info', 'exclude'),
        ['.git', 'node_modules', '.moo', '.venv', '__pycache__', 'dist', 'build', '.next', 'target', '*.log', '.DS_Store'].join('\n') + '\n',
      );
      this.enabled = true;
      return null;
    } catch (e: any) {
      return e.message;
    }
  }

  restoreList(list: Checkpoint[]) {
    this.list = list;
  }

  async create(label: string, messages: Message[]): Promise<Checkpoint | null> {
    if (!this.enabled) return null;
    try {
      await this.g(['add', '-A']);
      const tree = (await this.g(['write-tree'])).trim();
      const commit = (await this.g(['commit-tree', tree, '-m', label.slice(0, 200)])).trim();
      const n = (this.list.at(-1)?.n ?? 0) + 1;
      await this.g(['update-ref', `refs/moo/${sha(this.sessionDir)}-${n}`, commit]);
      writeFileSync(join(this.sessionDir, `cp-${n}.json`), JSON.stringify(messages));
      const cp = { n, label, commit, time: Date.now() };
      this.list.push(cp);
      return cp;
    } catch {
      return null;
    }
  }

  find(n: number) {
    return this.list.find((c) => c.n === n);
  }

  loadMessages(n: number): Message[] | null {
    const f = join(this.sessionDir, `cp-${n}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  }

  /** Restore the working tree to checkpoint n. Takes a safety snapshot first so rewinds are undoable. */
  async restoreCode(n: number, currentMessages: Message[]): Promise<Checkpoint> {
    const cp = this.find(n);
    if (!cp) throw new Error(`No checkpoint #${n}`);
    await this.create(`(auto) before rewind to #${n}`, currentMessages);
    await this.g(['add', '-A']);
    await this.g(['read-tree', '--reset', '-u', cp.commit]);
    return cp;
  }

  /** Summary of what changed in the working tree since checkpoint n. */
  async diffSince(n: number, full = false): Promise<string> {
    const cp = this.find(n);
    if (!cp) throw new Error(`No checkpoint #${n}`);
    await this.g(['add', '-A']);
    return (await this.g(['diff', '--cached', full ? '--no-color' : '--stat', cp.commit])).trim();
  }
}
