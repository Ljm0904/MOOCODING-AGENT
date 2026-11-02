import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(args: string[], env: Record<string, string>, cwd: string, stdin?: string) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|OPENAI|MOO)_/.test(k)));
    const p = spawn(process.execPath, [cli, ...args], { cwd, env: { ...clean, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdin ?? '');
  });
}

/** Scripted server: first call writes a file via a tool (when the prompt asks), then answers. */
function server() {
  const bodies: any[] = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const j = JSON.parse(b);
      bodies.push(j);
      const sawTool = j.messages.some((m: any) => m.role === 'tool');
      const wantsWrite = JSON.stringify(j.messages).includes('WRITE');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: any) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (wantsWrite && !sawTool) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'hello' }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: sawTool ? 'wrote it' : 'pong' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise<{ url: string; close: () => void; bodies: any[] }>((r) =>
    srv.listen(0, () => r({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close(), bodies })),
  );
}

describe('headless -p', () => {
  it('prints only the result to stdout; stdin is appended to the prompt', async () => {
    const s = await server();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moo-hl-')));
    const env = { MOO_HOME: join(dir, 'home'), OPENAI_API_KEY: 'k', OPENAI_BASE_URL: s.url, MOO_NO_MCP: '1' };
    const r = await run(['-p', 'ping', '--provider', 'openai', '--model', 'm'], env, dir, 'extra context');
    s.close();
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'pong\n');
    assert.match(JSON.stringify(s.bodies[0].messages), /<stdin>\\nextra context/);
  });

  it('json output has result + usage; yolo mode lets the tool write a file', async () => {
    const s = await server();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moo-hl2-')));
    const env = { MOO_HOME: join(dir, 'home'), OPENAI_API_KEY: 'k', OPENAI_BASE_URL: s.url, MOO_NO_MCP: '1' };
    const r = await run(['-p', 'WRITE a file', '--provider', 'openai', '--model', 'm', '--mode', 'yolo', '--output-format', 'json'], env, dir);
    s.close();
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.subtype, 'success');
    assert.equal(j.result, 'wrote it');
    assert.equal(j.num_tool_calls, 1);
    assert.deepEqual(j.usage, { input_tokens: 14, output_tokens: 6 });
    assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'hello');
  });

  it('default mode denies the write (nothing can prompt)', async () => {
    const s = await server();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moo-hl3-')));
    const env = { MOO_HOME: join(dir, 'home'), OPENAI_API_KEY: 'k', OPENAI_BASE_URL: s.url, MOO_NO_MCP: '1' };
    const r = await run(['-p', 'WRITE a file', '--provider', 'openai', '--model', 'm'], env, dir);
    s.close();
    assert.equal(existsSync(join(dir, 'out.txt')), false);
    assert.match(r.err, /headless default mode/);
  });

  it('exits 1 with a JSON error when not configured', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'moo-hl4-')));
    const r = await run(['-p', 'x', '--output-format', 'json'], { MOO_HOME: join(dir, 'home') }, dir);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).is_error, true);
  });
});
