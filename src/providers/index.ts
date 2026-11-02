import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from '../types.ts';
import { MOO_HOME } from '../util.ts';
import { anthropicProvider } from './anthropic.ts';
import { openaiProvider } from './openai.ts';

/**
 * Config precedence: CLI flags > env > ~/.moo/config.json.
 * config.json example:
 *   { "provider": "openai", "model": "deepseek-chat",
 *     "openai": { "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com/v1" } }
 */
export interface MooConfig {
  provider?: string;
  model?: string;
  anthropic?: { apiKey?: string; baseUrl?: string };
  openai?: { apiKey?: string; baseUrl?: string };
}

export function loadConfig(flags: { provider?: string; model?: string }): MooConfig {
  let file: MooConfig = {};
  const p = join(MOO_HOME, 'config.json');
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      console.error(`Warning: could not parse ${p}: ${e}`);
    }
  }
  const env = process.env;
  const anthropicKey = env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? file.anthropic?.apiKey;
  const openaiKey = env.OPENAI_API_KEY ?? file.openai?.apiKey;
  return {
    provider: flags.provider ?? env.MOO_PROVIDER ?? file.provider ?? (anthropicKey ? 'anthropic' : openaiKey ? 'openai' : undefined),
    model: flags.model ?? env.MOO_MODEL ?? file.model,
    anthropic: { apiKey: anthropicKey, baseUrl: env.ANTHROPIC_BASE_URL ?? file.anthropic?.baseUrl },
    openai: { apiKey: openaiKey, baseUrl: env.OPENAI_BASE_URL ?? file.openai?.baseUrl },
  };
}

export function createProvider(cfg: MooConfig, nameOverride?: string): Provider {
  const name = nameOverride ?? cfg.provider;
  if (name === 'anthropic') {
    if (!cfg.anthropic?.apiKey) throw new Error('Missing ANTHROPIC_API_KEY (or anthropic.apiKey in ~/.moo/config.json)');
    return anthropicProvider({ apiKey: cfg.anthropic.apiKey, baseUrl: cfg.anthropic.baseUrl });
  }
  if (name === 'openai') {
    // Local servers (Ollama etc.) often need no key.
    const key = cfg.openai?.apiKey ?? (cfg.openai?.baseUrl ? 'none' : undefined);
    if (!key) throw new Error('Missing OPENAI_API_KEY (or set OPENAI_BASE_URL for a local server)');
    return openaiProvider({ apiKey: key, baseUrl: cfg.openai?.baseUrl });
  }
  throw new Error(
    'No provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY (+ OPENAI_BASE_URL), or create ~/.moo/config.json.',
  );
}
