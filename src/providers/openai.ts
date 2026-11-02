import type { Block, CompletionRequest, CompletionResult, Message, Provider } from '../types.ts';
import { postJson, sseData } from './http.ts';

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

/** Convert internal (Anthropic-shaped) messages to OpenAI chat format. */
export function toOpenAIMessages(system: string, messages: Message[]): any[] {
  const out: any[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      // tool messages must directly follow the assistant tool_calls, so emit them first
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${b.content}` : b.content });
        }
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as any).text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    } else {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as any).text).join('\n');
      const calls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b: any) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

export function openaiProvider(cfg: OpenAIConfig): Provider {
  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  return {
    name: 'openai',
    defaultModel: cfg.defaultModel ?? 'gpt-4.1',
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const body: any = {
        model: req.model,
        max_tokens: req.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        messages: toOpenAIMessages(req.system, req.messages),
      };
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));
      }
      const res = await postJson(`${base}/chat/completions`, { authorization: `Bearer ${cfg.apiKey}` }, body, req.signal);

      let text = '';
      const calls: { id: string; name: string; args: string }[] = [];
      let finish: string | undefined;
      let input = 0;
      let output = 0;

      for await (const data of sseData(res)) {
        if (data === '[DONE]') break;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.error) throw new Error(`OpenAI stream error: ${ev.error.message ?? data}`);
        if (ev.usage) {
          input = ev.usage.prompt_tokens ?? input;
          output = ev.usage.completion_tokens ?? output;
        }
        const choice = ev.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        if (d.content) {
          text += d.content;
          req.onText?.(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? 0;
          calls[i] ??= { id: '', name: '', args: '' };
          if (tc.id) calls[i]!.id = tc.id;
          if (tc.function?.name) calls[i]!.name += tc.function.name;
          if (tc.function?.arguments) calls[i]!.args += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const content: Block[] = [];
      if (text) content.push({ type: 'text', text });
      calls.filter(Boolean).forEach((c, i) => {
        let input: Record<string, any> = {};
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {}
        content.push({ type: 'tool_use', id: c.id || `call_${Date.now()}_${i}`, name: c.name, input });
      });
      const hasCalls = content.some((b) => b.type === 'tool_use');
      return {
        content,
        stopReason: hasCalls ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end',
        usage: { input, output },
      };
    },
  };
}
