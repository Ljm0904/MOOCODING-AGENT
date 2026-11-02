const tty = process.stdout.isTTY || !!process.env.FORCE_COLOR;
const wrap = (open: number, close: number) => (s: string) => (tty ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const colorEnabled = tty;
export const c = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};
