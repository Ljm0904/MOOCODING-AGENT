import { c } from './colors.ts';

const isEnabled = () => !!process.stdout.isTTY && !process.env.MOO_NO_ANIM && !process.env.CI;

// Claude-style glyph that "blooms" and shrinks again.
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = [
  'Thinking', 'Pondering', 'Ruminating', 'Chewing', 'Grazing', 'Mooing', 'Herding', 'Churning', 'Mulling',
  'Noodling', 'Percolating', 'Simmering', 'Brewing', 'Cogitating', 'Contemplating', 'Tinkering', 'Wrangling',
];
const accent = (s: string) => (process.stdout.isTTY || process.env.FORCE_COLOR ? `\x1b[38;5;173m${s}\x1b[39m` : s);

const fmtTokens = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));
const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Text with a bright "shimmer" window sweeping across it. */
export function shimmer(text: string, pos: number): string {
  return [...text].map((ch, i) => (Math.abs(i - pos) <= 1 ? c.bold(ch) : accent(ch))).join('');
}

/**
 * A single process-wide status line ("✻ Pondering… (12s · ↓ 1.2k tokens · ctrl+c to interrupt)").
 * All UI output calls erase() first, so the line never interleaves with normal output; the timer
 * redraws it only while the cursor is at the start of a line (i.e. while waiting).
 */
class Spinner {
  private timer?: NodeJS.Timeout;
  private drawn = false;
  private active = false;
  private suspended = false;
  private midLine = false;
  private label: string | null = null;
  private startedAt = 0;
  private tokens = 0;
  private tick = 0;
  private verb = VERBS[0]!;
  private verbAt = 0;

  begin() {
    if (!isEnabled() || this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.tokens = 0;
    this.tick = 0;
    this.label = null;
    this.pickVerb();
    process.stdout.write('\x1b[?25l');
    this.timer = setInterval(() => this.draw(), 90);
    this.draw();
  }

  end() {
    if (!this.active) return;
    clearInterval(this.timer);
    this.erase();
    process.stdout.write('\x1b[?25h');
    this.active = false;
  }

  /** Fixed label (e.g. "Running bash") or null for the rotating verbs. */
  setLabel(l: string | null) {
    this.label = l;
  }
  addTokens(n: number) {
    this.tokens += n;
  }
  suspend(on: boolean) {
    this.suspended = on;
    if (on) this.erase();
  }
  setMidLine(b: boolean) {
    this.midLine = b;
    if (b) this.erase();
  }

  erase() {
    if (this.drawn) {
      process.stdout.write('\r\x1b[2K');
      this.drawn = false;
    }
  }

  private pickVerb() {
    let v = this.verb;
    while (v === this.verb) v = VERBS[Math.floor(Math.random() * VERBS.length)]!;
    this.verb = v;
    this.verbAt = Date.now();
  }

  private draw() {
    if (!this.active || this.suspended || this.midLine) return;
    if (!this.label && Date.now() - this.verbAt > 4000) this.pickVerb();
    this.tick++;
    const text = (this.label ?? this.verb) + '…';
    const glyph = accent(FRAMES[this.tick % FRAMES.length]!);
    const pos = (this.tick % (text.length + 8)) - 3;
    const parts = [fmtTime(Date.now() - this.startedAt)];
    if (this.tokens >= 1) parts.push(`↓ ${fmtTokens(this.tokens)} tokens`);
    parts.push('ctrl+c to interrupt');
    const width = process.stdout.columns || 80;
    let line = `${glyph} ${shimmer(text, pos)} ${c.dim('(' + parts.join(' · ') + ')')}`;
    // keep to one physical line: a wrapped line could not be erased with \r
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (visible.length >= width) line = `${glyph} ${shimmer(text, pos)}`;
    process.stdout.write('\r\x1b[2K' + line);
    this.drawn = true;
  }
}

export const spinner = new Spinner();
process.on('exit', () => {
  if (isEnabled()) process.stdout.write('\x1b[?25h');
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Short startup animation followed by a welcome box. Falls back to the static box when not a TTY. */
export async function playIntro(lines: string[]): Promise<void> {
  const title = 'Welcome to MOO';
  if (isEnabled()) {
    process.stdout.write('\x1b[?25l');
    for (let i = 0; i < FRAMES.length * 2; i++) {
      process.stdout.write(`\r\x1b[2K  ${accent(FRAMES[i % FRAMES.length]!)} ${shimmer(title, i - 2)}`);
      await sleep(55);
    }
    process.stdout.write('\r\x1b[2K\x1b[?25h');
  }
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const body = [`${accent('✻')} ${c.bold(title)}`, ...lines.map((l) => '  ' + l)];
  const max = Math.min((process.stdout.columns || 80) - 4, 100);
  const clip = (s: string) => (strip(s).length > max ? strip(s).slice(0, max - 1) + '…' : s);
  const rows = body.map(clip);
  const w = Math.max(...rows.map((r) => strip(r).length));
  const bar = '─'.repeat(w + 2);
  console.log(accent('╭' + bar + '╮'));
  for (const r of rows) console.log(accent('│') + ' ' + r + ' '.repeat(w - strip(r).length) + ' ' + accent('│'));
  console.log(accent('╰' + bar + '╯'));
}
