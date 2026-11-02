import type { Block, CompletionRequest, CompletionResult, Provider } from '../types.ts';
import { postJson, sseData } from './http.ts';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export function anthropicProvider(cfg: AnthropicConfig): Provider {
  const base = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  return {
    name: 'anthropic',
    defaultModel: cfg.defaultModel ?? 'claude-sonnet-5-5',
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const tools = req.tools.map((t, i) =>
        i === req.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
      );
      const body = {
        model: req.model,
        max_tokens: req.maxTokens,
        stream: true,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: req.messages,
        ...(tools.length ? { tools } : {}),
      };
      const res = await postJson(
        `${base}/v1/messages`,
        { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body,
        req.signal,
      );

      const blocks: (Block & { _json?: string })[] = [];
      let stop: string | undefined;
      let input = 0;
      let output = 0;

      for await (const data of sseData(res)) {
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        switch (ev.type) {
          case 'message_start': {
            const u = ev.message?.usage ?? {};
            input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            output = u.output_tokens ?? 0;
            break;
          }
          case 'content_block_start': {
            const b = ev.content_block;
            if (b.type === 'text') blocks[ev.index] = { type: 'text', text: '' };
            else if (b.type === 'tool_use') blocks[ev.index] = { type: 'tool_use', id: b.id, name: b.name, input: {}, _json: '' };
            break;
          }
          case 'content_block_delta': {
            const b = blocks[ev.index];
            if (!b) break;
            if (ev.delta.type === 'text_delta' && b.type === 'text') {
              b.text += ev.delta.text;
              req.onText?.(ev.delta.text);
            } else if (ev.delta.type === 'input_json_delta' && b.type === 'tool_use') {
              b._json += ev.delta.partial_json;
            }
            break;
          }
          case 'content_block_stop': {
            const b = blocks[ev.index];
            if (b?.type === 'tool_use') {
              try {
                b.input = b._json ? JSON.parse(b._json) : {};
              } catch {
                b.input = {};
              }
              delete b._json;
            }
            break;
          }
          case 'message_delta':
            stop = ev.delta?.stop_reason ?? stop;
            output = ev.usage?.output_tokens ?? output;
            break;
          case 'error':
            throw new Error(`Anthropic stream error: ${ev.error?.message ?? data}`);
        }
      }

      const content = blocks.filter((b) => b && !(b.type === 'text' && !b.text));
      return {
        content,
        stopReason: stop === 'tool_use' ? 'tool_use' : stop === 'max_tokens' ? 'max_tokens' : 'end',
        usage: { input, output },
      };
    },
  };
}
