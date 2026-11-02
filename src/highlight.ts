import { c } from './colors.ts';

/**
 * Small dependency-free syntax highlighter for fenced code blocks. It is line-based (so it works on
 * streamed output) and keeps a little state for constructs that span lines (block comments,
 * triple-quoted strings). It is deliberately approximate: good colors, not a parser.
 */

interface Lang {
  kw: Set<string>;
  lit?: Set<string>;
  line?: string[]; // line-comment starters
  block?: [string, string, 'comment' | 'string'][]; // multi-line constructs
  quotes?: string; // string delimiters
  types?: boolean; // Capitalized identifiers → type color
  vars?: boolean; // $VAR (shell)
  at?: boolean; // @decorator / @annotation
  json?: boolean; // "key": coloring
  ci?: boolean; // case-insensitive keywords (SQL)
  yaml?: boolean;
}

const w = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const C_LIKE_LIT = w('true false null undefined NaN Infinity nil None True False this self super');

const JS: Lang = {
  kw: w(`const let var function return if else for while do switch case break continue new delete typeof instanceof in of
    class extends import export from default async await yield try catch finally throw void static get set
    interface type enum implements public private protected readonly abstract declare namespace as is keyof satisfies`),
  lit: C_LIKE_LIT, line: ['//'], block: [['/*', '*/', 'comment']], quotes: '"\'`', types: true, at: true,
};
const PY: Lang = {
  kw: w(`def class return if elif else for while in not and or is import from as with try except finally raise pass break
    continue lambda yield global nonlocal assert del async await match case`),
  lit: C_LIKE_LIT, line: ['#'], block: [['"""', '"""', 'string'], ["'''", "'''", 'string']], quotes: '"\'', types: true, at: true,
};
const SH: Lang = {
  kw: w(`if then else elif fi for while until do done case esac in function select time export local readonly return
    exit cd echo set unset source alias`),
  lit: w('true false'), line: ['#'], quotes: '"\'', vars: true,
};
const GO: Lang = {
  kw: w(`func return if else for range switch case default break continue go defer select chan map struct interface type
    package import var const fallthrough goto`),
  lit: w('true false nil iota'), line: ['//'], block: [['/*', '*/', 'comment']], quotes: '"\'`', types: true,
};
const RUST: Lang = {
  kw: w(`fn let mut const static return if else for while loop match break continue struct enum impl trait pub use mod
    crate self super as in where move ref async await dyn unsafe type extern`),
  lit: w('true false None Some Ok Err'), line: ['//'], block: [['/*', '*/', 'comment']], quotes: '"\'', types: true,
};
const JAVA: Lang = {
  kw: w(`class interface enum extends implements public private protected static final abstract void return if else for
    while do switch case default break continue new throw throws try catch finally import package this super
    int long short byte char boolean float double var const struct typedef sizeof namespace using template typename
    virtual override inline unsigned signed volatile extern auto`),
  lit: w('true false null nullptr NULL'), line: ['//'], block: [['/*', '*/', 'comment']], quotes: '"\'', types: true, at: true,
};
const SQL: Lang = {
  kw: w(`select from where insert into values update set delete create table alter drop index join left right inner outer
    full on group by order having limit offset as and or not in is like between distinct union all case when then else end
    primary key foreign references default unique with returning`),
  lit: w('null true false'), line: ['--'], block: [['/*', '*/', 'comment']], quotes: '"\'', ci: true,
};
const JSON_L: Lang = { kw: new Set(), lit: w('true false null'), quotes: '"', json: true };
const YAML: Lang = { kw: new Set(), lit: w('true false null yes no ~'), line: ['#'], quotes: '"\'', yaml: true };

const LANGS: Record<string, Lang | 'diff' | 'html' | 'css'> = {
  js: JS, javascript: JS, jsx: JS, ts: JS, typescript: JS, tsx: JS, mjs: JS, cjs: JS,
  py: PY, python: PY,
  sh: SH, bash: SH, shell: SH, zsh: SH, console: SH,
  go: GO, golang: GO,
  rs: RUST, rust: RUST,
  java: JAVA, kotlin: JAVA, kt: JAVA, c: JAVA, h: JAVA, cpp: JAVA, 'c++': JAVA, cc: JAVA, hpp: JAVA, cs: JAVA, csharp: JAVA, swift: JAVA, scala: JAVA, dart: JAVA, php: JAVA,
  sql: SQL,
  json: JSON_L, jsonc: JSON_L, json5: JSON_L,
  yaml: YAML, yml: YAML, toml: YAML,
  diff: 'diff', patch: 'diff',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', less: 'css',
};

interface State {
  block: { close: string; kind: 'comment' | 'string' } | null;
}

const NUM = /0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_$][\w$]*/y;
const VAR = /\$\{?[A-Za-z_]\w*\}?|\$[@#?$!0-9*]/y;
const AT = /@[A-Za-z_][\w.]*/y;
const sticky = (re: RegExp, s: string, i: number) => {
  re.lastIndex = i;
  return re.exec(s)?.[0];
};
const paint = (kind: 'comment' | 'string', s: string) => (kind === 'comment' ? c.gray(s) : c.green(s));

function scan(line: string, lang: Lang, st: State, start = 0): string {
  let out = '';
  let i = start;
  if (st.block && start === 0) {
    const end = line.indexOf(st.block.close);
    if (end < 0) return paint(st.block.kind, line);
    out += paint(st.block.kind, line.slice(0, end + st.block.close.length));
    i = end + st.block.close.length;
    st.block = null;
  }
  while (i < line.length) {
    const ch = line[i]!;
    if (lang.line?.some((p) => line.startsWith(p, i))) return out + c.gray(line.slice(i));

    const blk = lang.block?.find(([open]) => line.startsWith(open, i));
    if (blk) {
      const end = line.indexOf(blk[1], i + blk[0].length);
      if (end < 0) {
        st.block = { close: blk[1], kind: blk[2] };
        return out + paint(blk[2], line.slice(i));
      }
      out += paint(blk[2], line.slice(i, end + blk[1].length));
      i = end + blk[1].length;
      continue;
    }
    if (lang.quotes?.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, line.length);
      const tok = line.slice(i, end);
      const isKey = lang.json && /^\s*:/.test(line.slice(end));
      out += isKey ? c.cyan(tok) : c.green(tok);
      i = end;
      continue;
    }
    if (lang.vars && ch === '$') {
      const v = sticky(VAR, line, i);
      if (v) {
        out += c.cyan(v);
        i += v.length;
        continue;
      }
    }
    if (lang.at && ch === '@') {
      const a = sticky(AT, line, i);
      if (a) {
        out += c.yellow(a);
        i += a.length;
        continue;
      }
    }
    if (/\d/.test(ch) && !/[\w$]/.test(line[i - 1] ?? '')) {
      const n = sticky(NUM, line, i);
      if (n) {
        out += c.yellow(n);
        i += n.length;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const id = sticky(IDENT, line, i)!;
      const key = lang.ci ? id.toLowerCase() : id;
      if (lang.kw.has(key)) out += c.magenta(id);
      else if (lang.lit?.has(id)) out += c.yellow(id);
      else if (lang.types && /^[A-Z]/.test(id) && /[a-z]/.test(id)) out += c.cyan(id); // types, constructors, components
      else if (line[i + id.length] === '(') out += c.blue(id);
      else out += id;
      i += id.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const html = (line: string) =>
  line.replace(/(<!--.*?-->)|("[^"]*"|'[^']*')|(<\/?[\w:-]+|\/?>)|([\w:-]+)(?==)/g, (_, cm, str, tag, attr) =>
    cm ? c.gray(cm) : str ? c.green(str) : tag ? c.blue(tag) : c.cyan(attr),
  );

const css = (line: string) =>
  line.replace(/(\/\*.*?\*\/)|("[^"]*"|'[^']*')|(#[\da-fA-F]{3,8}\b|-?\b\d[\w.%]*)|([\w-]+)(?=\s*:)|([.#][\w-]+|@[\w-]+)/g, (_, cm, str, num, prop, sel) =>
    cm ? c.gray(cm) : str ? c.green(str) : num ? c.yellow(num) : prop ? c.cyan(prop) : c.magenta(sel),
  );

const diff = (line: string) =>
  /^(\+\+\+|---|diff |index )/.test(line) ? c.bold(line)
  : line.startsWith('@@') ? c.cyan(line)
  : line.startsWith('+') ? c.green(line)
  : line.startsWith('-') ? c.red(line)
  : line;

/** Returns a stateful line highlighter for `lang`, or null when the language is unknown. */
export function createHighlighter(lang: string): ((line: string) => string) | null {
  const def = LANGS[lang.toLowerCase()];
  if (!def) return null;
  if (def === 'diff') return diff;
  if (def === 'html') return html;
  if (def === 'css') return css;
  const st: State = { block: null };
  if (def.yaml) {
    return (line) => {
      const m = /^(\s*(?:-\s+)?)([\w."'/-]+)(:)(?=\s|$)/.exec(line);
      if (!m) return scan(line, def, st);
      return m[1] + c.cyan(m[2]!) + m[3] + scan(line, def, st, m[0].length);
    };
  }
  return (line) => scan(line, def, st);
}
