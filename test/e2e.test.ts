// End-to-end tests against a scripted OpenAI-compatible mock server (no network / API key needed).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'moo-home-'));
process.env.MOO_HOME = home;

const { Agent } = await import('../src/agent.ts');
const { Checkpoints } = await import('../src/checkpoint.ts');
const { Permissions } = await import('../src/permissions.ts');
const { openaiProvider } = await import('../src/providers/openai.ts');
const { baseTools } = await import('../src/tools/index.ts');
const { makeParallelTool } = await import('../src/tools/subagents.ts');
const { Tracer } = await import('../src/trace.ts');
const { UI } = await import('../src/ui.ts');
const { globToRegex } = await import('../src/util.ts');
const { detectVerifyCommands } = await import('../src/verify.ts');

type Step = { text?: string; calls?: { name: string; args: any }[] };

/** Mock chat-completions server. Each request pops the next scripted step for that "channel" (system-prompt marker). */
function mockServer(scripts: Record<string, Step[]>): Promise<{ server: Server; url: string; seen: any[] }> {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push(j);
      const sys: string = j.messages[0].content;
      const key = Object.keys(scripts).find((k) => sys.includes(k)) ?? 'default';
      const step = scripts[key]?.shift() ?? { text: 'done' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (step.text) for (const ch of step.text.match(/.{1,5}/gs) ?? []) send({ choices: [{ delta: { content: ch } }] });
      (step.calls ?? []).forEach((c, i) => {
        const args = JSON.stringify(c.args);
        send({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${seen.length}_${i}`, function: { name: c.name, arguments: args.slice(0, 7) } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(7) } }] } }] });
      });
      send({ choices: [{ delta: {}, finish_reason: step.calls?.length ? 'tool_calls' : 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen })));
}

const sh = (cmd: string, cwd: string) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const quietUI = () => {
  const u = new UI('', true);
  return u;
};

describe('util', () => {
  it('globToRegex', () => {
    assert.ok(globToRegex('**/*.ts').test('src/a/b.ts'));
    assert.ok(globToRegex('**/*.ts').test('b.ts'));
    assert.ok(!globToRegex('*.ts').test('src/b.ts'));
    assert.ok(globToRegex('src/**/*.{ts,js}').test('src/x/y.js'));
  });
});

describe('agent loop + tools (OpenAI-compatible streaming)', () => {
  let srv: Awaited<ReturnType<typeof mockServer>>;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moo-proj-')));

  before(async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello world\n');
    srv = await mockServer({
      default: [
        { calls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'glob', args: { pattern: '*.txt' } }] },
        { calls: [{ name: 'edit_file', args: { path: 'a.txt', old_string: 'world', new_string: 'moo' } }] },
        { calls: [{ name: 'bash', args: { command: 'cat a.txt' } }] },
        { text: 'All done.' },
      ],
    });
  });
  after(() => srv.server.close());

  it('streams, runs tools (parallel read-only then sequential edit), and traces', async () => {
    const tracer = new Tracer(join(home, 'sess1'));
    const agent = new Agent({
      id: 'main',
      provider: openaiProvider({ apiKey: 'x', baseUrl: srv.url, defaultModel: 'm' }),
      model: 'm',
      cwd: dir,
      tools: baseTools(),
      permissions: new Permissions('yolo', async () => 'n'),
      tracer,
      ui: quietUI(),
      system: 'SYS',
    });
    const out = await agent.run('please edit');
    assert.equal(out, 'All done.');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'hello moo\n');
    // the tool_result for read_file was sent back (as role=tool) on the 2nd request
    const second = srv.seen[1].messages;
    assert.equal(second.filter((m: any) => m.role === 'tool').length, 2);
    assert.match(second.find((m: any) => m.role === 'tool').content, /hello world/);
    const s = tracer.stats();
    assert.equal(s.llmCalls, 4);
    assert.equal(s.inputTokens, 400); // numbers must stay numbers in the trace (was string-concatenated once)
    assert.equal(s.outputTokens, 80);
    assert.equal(s.toolCalls, 4);
    assert.equal(agent.dirty, true);
    const html = tracer.exportHtml();
    assert.ok(existsSync(html));
    assert.match(readFileSync(html, 'utf8'), /MOO execution trace/);
    assert.ok(!readFileSync(html, 'utf8').includes('__DATA__'));
  });

  it('default mode denies when user answers no, and plan mode blocks edits', async () => {
    const tracer = new Tracer(join(home, 'sess2'));
    const bash = baseTools().find((t) => t.spec.name === 'bash')!;
    const perm = new Permissions('default', async () => 'n');
    assert.equal((await perm.check(bash, { command: 'ls' }, 'ls')).ok, false);
    const always = new Permissions('default', async () => 'a');
    assert.equal((await always.check(bash, { command: 'ls' }, 'ls')).ok, true);
    assert.equal((await new Permissions('plan', async () => 'y').check(bash, {}, '')).ok, false);
    void tracer;
  });

  it('rejects edits outside cwd and non-unique matches', async () => {
    const edit = baseTools().find((t) => t.spec.name === 'edit_file')!;
    const ctx = { cwd: dir, agentId: 't', setTodos() {}, setPlan() {}, requestStop() {} };
    await assert.rejects(edit.run({ path: '/etc/hosts', old_string: 'a', new_string: 'b' }, ctx), /outside the working directory/);
    writeFileSync(join(dir, 'dup.txt'), 'x x');
    await assert.rejects(edit.run({ path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx), /occurs 2 times/);
  });
});

describe('checkpoints (shadow git)', () => {
  it('rewinds modified, created and deleted files without touching the user repo', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moo-cp-')));
    sh('git init -q && git config user.email a@b && git config user.name t', dir);
    writeFileSync(join(dir, 'keep.txt'), 'v1');
    writeFileSync(join(dir, 'gone.txt'), 'bye');
    const sessDir = join(home, 'sess-cp');
    const cps = new Checkpoints(dir, (await import('node:fs')).mkdirSync(sessDir, { recursive: true }) ?? sessDir);
    assert.equal(await cps.init(), null);
    const cp1 = await cps.create('before', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    assert.equal(cp1?.n, 1);

    writeFileSync(join(dir, 'keep.txt'), 'v2');
    writeFileSync(join(dir, 'new.txt'), 'new');
    sh('rm gone.txt', dir);
    assert.match(await cps.diffSince(1), /keep\.txt/);

    await cps.restoreCode(1, []);
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'v1');
    assert.equal(readFileSync(join(dir, 'gone.txt'), 'utf8'), 'bye');
    assert.ok(!existsSync(join(dir, 'new.txt')));
    assert.equal(sh('git log --oneline 2>&1 || true', dir).includes('moo'), false); // user repo untouched
    assert.equal(cps.loadMessages(1)?.length, 1);
    assert.ok(cps.list.length >= 2); // safety checkpoint was added
  });
});

describe('parallel_tasks with git worktrees', () => {
  it('runs two workers in isolation and merges both', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moo-par-')));
    sh('git init -q -b main && git config user.email a@b && git config user.name t', dir);
    writeFileSync(join(dir, 'base.txt'), 'base');
    sh('git add -A && git commit -qm init', dir);

    // Deterministic per-worker scripting: key on the task prompt text inside the user message.
    const seen: any[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const j = JSON.parse(body);
        seen.push(j);
        const user = j.messages.find((m: any) => m.role === 'user').content as string;
        const file = user.includes('ALPHA') ? 'alpha.txt' : 'beta.txt';
        const hasTool = j.messages.some((m: any) => m.role === 'tool');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (!hasTool) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: file }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ choices: [{ delta: { content: `made ${file}` } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    const tracer = new Tracer(join(home, 'sess-par'));
    const tool = makeParallelTool({ provider: openaiProvider({ apiKey: 'x', baseUrl: url, defaultModel: 'm' }), model: 'm', tracer, ui: quietUI(), cwd: dir });
    const out = await tool.run(
      { tasks: [{ name: 'alpha', prompt: 'ALPHA do it' }, { name: 'beta', prompt: 'BETA do it' }] },
      { cwd: dir, agentId: 'main', setTodos() {}, setPlan() {}, requestStop() {} },
    );
    server.close();
    assert.match(out, /alpha — merged/);
    assert.match(out, /beta — merged/);
    assert.equal(readFileSync(join(dir, 'alpha.txt'), 'utf8'), 'alpha.txt');
    assert.equal(readFileSync(join(dir, 'beta.txt'), 'utf8'), 'beta.txt');
    assert.equal(sh('git worktree list', dir).trim().split('\n').length, 1); // worktrees cleaned up
    assert.equal(sh('git branch --list "moo/*"', dir).trim(), ''); // branches cleaned up
    assert.ok(tracer.events.some((e) => e.agent.startsWith('worker-1')));
  });
});

describe('verify detection', () => {
  it('detects npm scripts, ignoring the default no-test stub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moo-ver-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', check: 'tsc' } }));
    assert.deepEqual(detectVerifyCommands(dir), ['npm run check']);
  });
});
