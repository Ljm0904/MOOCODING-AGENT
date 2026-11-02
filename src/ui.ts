import type { Interface } from 'node:readline/promises';
import { c, colorEnabled } from './colors.ts';
import { MdStream } from './markdown.ts';
import { spinner } from './spinner.ts';
import type { Todo } from './types.ts';

export { c };

/**
 * Terminal output. The root UI streams model text and shows tool results;
 * child UIs (used by parallel sub-agents) are prefixed and quiet so
 * interleaved output stays readable.
 */
export class UI {
  rl?: Interface;
  prefix: string;
  quiet: boolean;
  private midLine = false;

  constructor(prefix = '', quiet = false) {
    this.prefix = prefix;
    this.quiet = quiet;
  }

  child(prefix: string): UI {
    const u = new UI(prefix, true);
    u.rl = this.rl;
    return u;
  }

  private md = new MdStream(colorEnabled && !process.env.MOO_RAW);

  stream(text: string) {
    if (this.quiet) return;
    spinner.addTokens(text.length / 4);
    const out = this.md.push(text);
    if (out) {
      spinner.erase();
      process.stdout.write(out);
    }
    this.midLine = this.md.pending || (out !== '' && !out.endsWith('\n'));
    spinner.setMidLine(this.midLine);
  }

  /** Show/hide the animated status line for a running agent turn (root UI only). */
  busy(on: boolean) {
    if (this.quiet) return;
    if (on) spinner.begin();
    else spinner.end();
  }

  /** Fixed spinner label such as "Running bash"; null → rotating verbs. */
  status(label: string | null) {
    if (!this.quiet) spinner.setLabel(label);
  }

  private endLine() {
    spinner.erase();
    if (this.midLine) {
      const rest = this.md.flush();
      process.stdout.write(rest + '\n');
      this.midLine = false;
      spinner.setMidLine(false);
    }
  }

  private pfx() {
    return this.prefix ? c.magenta(this.prefix) + ' ' : '';
  }

  line(s = '') {
    this.endLine();
    console.log(s);
  }
  info(s: string) {
    this.line(this.pfx() + c.dim(s));
  }
  warn(s: string) {
    this.line(this.pfx() + c.yellow(s));
  }
  error(s: string) {
    this.line(this.pfx() + c.red(s));
  }
  ok(s: string) {
    this.line(this.pfx() + c.green(s));
  }

  toolCall(name: string, desc: string) {
    this.line(`${this.pfx()}${c.cyan('●')} ${c.bold(name)}${c.dim('(' + desc.replace(/\s+/g, ' ').slice(0, 100) + ')')}`);
  }

  toolResult(output: string, isError: boolean) {
    if (this.quiet) return;
    const lines = output.split('\n').filter((l) => l.trim());
    const shown = lines.slice(0, 4).map((l) => '  ⎿ ' + l.slice(0, 120));
    if (lines.length > 4) shown.push(`  ⎿ … +${lines.length - 4} lines`);
    if (shown.length) this.line((isError ? c.red : c.dim)(shown.join('\n')));
  }

  todos(todos: Todo[]) {
    if (this.quiet) return;
    const icon = { pending: '☐', in_progress: '◐', completed: '☑' } as const;
    this.line(todos.map((t) => `  ${icon[t.status]} ${t.status === 'completed' ? c.dim(t.content) : t.content}`).join('\n'));
  }

  async ask(question: string): Promise<string> {
    this.endLine();
    if (!this.rl) return 'n';
    spinner.suspend(true);
    try {
      return (await this.rl.question(question)).trim();
    } finally {
      spinner.suspend(false);
    }
  }
}
