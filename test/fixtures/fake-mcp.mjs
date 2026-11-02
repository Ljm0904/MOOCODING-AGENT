// Minimal MCP server over stdio (newline-delimited JSON-RPC) for tests.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  if (m.method === 'tools/list')
    return reply(m.id, {
      tools: [
        { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
      ],
    });
  if (m.method === 'tools/call') {
    if (m.params.name === 'echo') return reply(m.id, { content: [{ type: 'text', text: 'echo:' + m.params.arguments.text }] });
    return reply(m.id, { isError: true, content: [{ type: 'text', text: 'kaboom' }] });
  }
});
