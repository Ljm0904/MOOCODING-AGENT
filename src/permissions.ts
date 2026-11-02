import type { Tool } from './types.ts';
import { c } from './ui.ts';

/**
 * default   – ask before edits and shell commands
 * auto-edit – edits auto-approved, shell still asks
 * yolo      – everything auto-approved (sub-agents in isolated worktrees use this)
 * plan      – read-only: every mutating tool is refused
 */
export type Mode = 'default' | 'auto-edit' | 'yolo' | 'plan';
export const MODES: Mode[] = ['default', 'auto-edit', 'yolo', 'plan'];

export class Permissions {
  mode: Mode;
  private allowed = new Set<string>();
  private ask: (q: string) => Promise<string>;

  constructor(mode: Mode, ask: (q: string) => Promise<string>) {
    this.mode = mode;
    this.ask = ask;
  }

  async check(tool: Tool, input: Record<string, any>, desc: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (tool.readOnly) return { ok: true };
    if (this.mode === 'plan') return { ok: false, reason: 'Plan mode is read-only. Use submit_plan to propose changes.' };
    if (this.mode === 'yolo') return { ok: true };
    if (this.mode === 'auto-edit' && tool.kind === 'edit') return { ok: true };

    const key = tool.spec.name === 'bash' ? `bash:${String(input.command ?? '').trim().split(/\s+/)[0]}` : tool.spec.name;
    if (this.allowed.has(key)) return { ok: true };

    const answer = (
      await this.ask(
        `${c.yellow('?')} Allow ${c.bold(tool.spec.name)} ${c.dim(desc.slice(0, 160))}\n  [y]es / [a]lways for ${key} / [n]o (or type feedback): `,
      )
    ).toLowerCase();
    if (answer === 'y' || answer === 'yes' || answer === '') return { ok: true };
    if (answer === 'a' || answer === 'always') {
      this.allowed.add(key);
      return { ok: true };
    }
    if (answer === 'n' || answer === 'no') return { ok: false, reason: 'The user denied this action.' };
    return { ok: false, reason: `The user denied this action and said: ${answer}` };
  }
}
