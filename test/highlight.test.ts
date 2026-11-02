import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.FORCE_COLOR = '1';
const { createHighlighter } = await import('../src/highlight.ts');
const { MdStream } = await import('../src/markdown.ts');

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const M = '\x1b[35m', Y = '\x1b[33m', G = '\x1b[32m', B = '\x1b[34m', CY = '\x1b[36m', GR = '\x1b[90m', R = '\x1b[31m';
const has = (s: string, color: string, text: string) => s.includes(`${color}${text}\x1b[`);

describe('syntax highlighting', () => {
  it('never changes the text (all languages)', () => {
    const samples: Record<string, string[]> = {
      ts: ['const x: Map<string, number> = new Map(); // hi', '/* open', 'still comment */ let y = `t${1}`;', '@Dec() class A {}'],
      py: ['def f(x): # c', '    """doc', '    more"""', "    return f'a\\'b' + 0x1F"],
      sh: ['if [ -n "$HOME" ]; then echo ${X:-1} # c', 'fi'],
      json: ['{"a": [1, 2.5e3, true, null], "b": "x\\"y"}'],
      yaml: ['key: "v" # c', '- name: true'],
      sql: ['SELECT a, b FROM t WHERE x = 1 -- c'],
      html: ['<div class="a" id=\'b\'>hi</div><!-- c -->'],
      css: ['.a { color: #fff; margin: 0 auto; } /* c */'],
      diff: ['@@ -1 +1 @@', '-old', '+new', ' ctx'],
      go: ['func main() { fmt.Println("hi") }'],
      rust: ['fn main() { let x: u32 = 5; }'],
    };
    for (const [lang, lines] of Object.entries(samples)) {
      const hl = createHighlighter(lang)!;
      assert.ok(hl, lang);
      for (const l of lines) assert.equal(strip(hl(l)), l, `${lang}: ${l}`);
    }
  });

  it('colors the right tokens', () => {
    const ts = createHighlighter('ts')!;
    const a = ts('const n = 42; // note');
    assert.ok(has(a, M, 'const') && has(a, Y, '42') && has(a, GR, '// note'));
    const b = ts('foo("s"); const T = new Map();');
    assert.ok(has(b, B, 'foo') && has(b, G, '"s"') && has(b, CY, 'Map'));
    assert.ok(!has(ts('my_constant = 1'), M, 'const')); // keyword only on whole identifiers
    const json = createHighlighter('json')!('{"k": "v", "n": 1, "t": true}');
    assert.ok(has(json, CY, '"k"') && has(json, G, '"v"') && has(json, Y, '1') && has(json, Y, 'true'));
    const d = createHighlighter('diff')!;
    assert.ok(d('+x').includes(G) && d('-x').includes(R));
    assert.ok(has(createHighlighter('sh')!('echo $HOME'), CY, '$HOME'));
    assert.ok(has(createHighlighter('sql')!('select 1'), M, 'select'));
  });

  it('tracks multi-line block comments and triple-quoted strings', () => {
    const ts = createHighlighter('ts')!;
    assert.ok(ts('/* a').includes(GR));
    assert.ok(has(ts('b const */'), GR, 'b const */'));
    assert.ok(has(ts('const z'), M, 'const')); // state cleared
    const py = createHighlighter('python')!;
    assert.ok(has(py('x = """abc'), G, '"""abc'));
    assert.ok(has(py('def inside'), G, 'def inside')); // still inside the string
    assert.ok(py('end""" + 1').includes(Y));
  });

  it('unknown language → null; wired into markdown fences', () => {
    assert.equal(createHighlighter('brainfuck'), null);
    const md = new MdStream(true);
    const out = md.push('```ts\nconst x = 1;\n```\n```zzz\nconst x = 1;\n```\n');
    const [, ts, , , unk] = out.split('\n');
    assert.ok(ts!.includes(M + 'const'));
    assert.ok(!unk!.includes(M));
  });
});
