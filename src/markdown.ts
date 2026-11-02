import { c } from './colors.ts';
import { createHighlighter } from './highlight.ts';

/** Inline markdown → ANSI: `code`, **bold**, *italic*, [text](url). */
export function renderInline(s: string): string {
  return s
    .split(/(`+[^`]+`+)/)
    .map((seg, i) => {
      if (i % 2 === 1) return c.cyan(seg.replace(/^`+|`+$/g, ''));
      return seg
        .replace(/\*\*(.+?)\*\*/g, (_, t) => c.bold(t))
        .replace(/(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, (_, t) => c.italic(t))
        .replace(/~~(.+?)~~/g, (_, t) => c.dim(t))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `${c.underline(t)} ${c.dim('(' + u + ')')}`);
    })
    .join('');
}

/**
 * Incremental, line-oriented markdown renderer for streamed model output.
 * Feed text deltas to push(); complete lines come back rendered, the unfinished
 * tail is held in `pending` until its newline arrives (or flush()).
 */
export class MdStream {
  private buf = '';
  private inFence = false;
  private hl: ((line: string) => string) | null = null;
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  get pending(): boolean {
    return this.buf.length > 0;
  }

  push(text: string): string {
    if (!this.enabled) return text;
    this.buf += text;
    let out = '';
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      out += this.renderLine(this.buf.slice(0, i)) + '\n';
      this.buf = this.buf.slice(i + 1);
    }
    return out;
  }

  /** Render whatever is left (no trailing newline) and reset block state. */
  flush(): string {
    const rest = this.buf ? this.renderLine(this.buf) : '';
    this.buf = '';
    this.inFence = false;
    this.hl = null;
    return rest;
  }

  private renderLine(line: string): string {
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      this.inFence = !this.inFence;
      this.hl = this.inFence ? createHighlighter(fence[2] ?? '') : null;
      return this.inFence ? c.dim(`  ┌─ ${fence[2] || 'code'}`) : c.dim('  └─');
    }
    if (this.inFence) return c.dim('  │ ') + (this.hl ? this.hl(line) : line);

    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const t = renderInline(m[2]!);
      return m[1]!.length <= 2 ? c.bold(c.underline(c.magenta(t))) : c.bold(c.magenta(t));
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return c.dim('─'.repeat(40));
    if ((m = /^(\s*)>\s?(.*)$/.exec(line))) return `${m[1]}${c.dim('│')} ${c.italic(renderInline(m[2]!))}`;
    if ((m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      return `${m[1]}${m[2] === ' ' ? '☐' : c.green('☑')} ${renderInline(m[3]!)}`;
    }
    if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) return `${m[1]}${c.cyan('•')} ${renderInline(m[2]!)}`;
    if ((m = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line))) return `${m[1]}${c.cyan(m[2]!)} ${renderInline(m[3]!)}`;
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')) return c.dim(line.replace(/[^|]/g, '─').replace(/\|/g, '┼'));
      return renderInline(line).replace(/\|/g, c.dim('│'));
    }
    return renderInline(line);
  }
}
