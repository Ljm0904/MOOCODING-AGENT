import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint } from './checkpoint.ts';
import type { Message } from './types.ts';
import { MOO_HOME } from './util.ts';

interface Meta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  updated: number;
}

export class Session {
  id: string;
  dir: string;
  meta: Meta;

  constructor(cwd: string, provider: string, model: string, id?: string) {
    this.id = id ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
    this.dir = join(MOO_HOME, 'sessions', this.id);
    mkdirSync(this.dir, { recursive: true });
    this.meta = { id: this.id, cwd, provider, model, updated: Date.now() };
  }

  save(messages: Message[], checkpoints: Checkpoint[], model: string) {
    this.meta.updated = Date.now();
    this.meta.model = model;
    writeFileSync(join(this.dir, 'session.json'), JSON.stringify({ meta: this.meta, messages, checkpoints }));
  }

  /** Find the most recently updated session for this directory. */
  static latest(cwd: string): { id: string; messages: Message[]; checkpoints: Checkpoint[]; meta: Meta } | null {
    const root = join(MOO_HOME, 'sessions');
    if (!existsSync(root)) return null;
    let best: { id: string; messages: Message[]; checkpoints: Checkpoint[]; meta: Meta } | null = null;
    for (const id of readdirSync(root)) {
      const f = join(root, id, 'session.json');
      if (!existsSync(f)) continue;
      try {
        const s = JSON.parse(readFileSync(f, 'utf8'));
        if (s.meta.cwd === cwd && (!best || s.meta.updated > best.meta.updated)) best = { id, ...s };
      } catch {}
    }
    return best;
  }
}
