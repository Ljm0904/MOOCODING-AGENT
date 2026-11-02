import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { Interface } from 'node:readline/promises';
import type { MooConfig } from './providers/index.ts';
import { c } from './ui.ts';
import { MOO_HOME } from './util.ts';

const DEFAULT_URL = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1' } as const;
type Name = keyof typeof DEFAULT_URL;

/**
 * readline writes its echo to this stream, which forwards to stdout unless muted
 * (used for API-key entry). It mimics a TTY so readline keeps line editing.
 */
export const gate = { muted: false };
export const gatedOutput = new Writable({
  write(chunk, enc, cb) {
    if (!gate.muted) process.stdout.write(chunk, enc as BufferEncoding);
    cb();
  },
}) as Writable & { isTTY: boolean; columns: number; rows: number };
gatedOutput.isTTY = !!process.stdout.isTTY;
Object.defineProperty(gatedOutput, 'columns', { get: () => process.stdout.columns ?? 80 });
Object.defineProperty(gatedOutput, 'rows', { get: () => process.stdout.rows ?? 24 });

/** Read a secret without echoing it. */
async function askSecret(rl: Interface, prompt: string): Promise<string> {
  process.stdout.write(prompt);
  gate.muted = true;
  try {
    return (await rl.question('')).trim();
  } finally {
    gate.muted = false;
    process.stdout.write('\n');
  }
}

async function listModels(name: Name, baseUrl: string, apiKey: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  const url = name === 'anthropic' ? `${base}/v1/models?limit=50` : `${base}/models`;
  const headers: Record<string, string> =
    name === 'anthropic' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const j: any = await res.json();
    return (j.data ?? []).map((m: any) => String(m.id)).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveConfig(cfg: MooConfig) {
  mkdirSync(MOO_HOME, { recursive: true });
  const p = join(MOO_HOME, 'config.json');
  let file: any = {};
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, 'utf8'));
    } catch {}
  }
  const name = cfg.provider as Name;
  file.provider = name;
  file.model = cfg.model;
  file[name] = { ...file[name], ...cfg[name] };
  writeFileSync(p, JSON.stringify(file, null, 2));
  try {
    chmodSync(p, 0o600); // contains an API key
  } catch {}
  return p;
}

/**
 * Interactive first-run (or /setup) wizard: provider → base URL → API key → model.
 * The model is chosen by the user, from the provider's live model list when available.
 */
export async function runSetup(rl: Interface, current?: MooConfig): Promise<MooConfig> {
  console.log(`\n${c.bold('MOO setup')} ${c.dim('(Enter accepts the [default])')}`);

  const curName = (current?.provider as Name | undefined) ?? 'anthropic';
  console.log('  1) Anthropic API\n  2) OpenAI-compatible (OpenAI, DeepSeek, Qwen, Moonshot, Ollama, …)');
  const pick = (await rl.question(`Provider [${curName === 'openai' ? 2 : 1}]: `)).trim();
  const name: Name = pick === '2' || /^openai/i.test(pick) ? 'openai' : pick === '1' || /^anthropic/i.test(pick) ? 'anthropic' : curName;

  const curUrl = current?.[name]?.baseUrl ?? DEFAULT_URL[name];
  const urlIn = (await rl.question(`Base URL [${curUrl}]: `)).trim();
  const baseUrl = (urlIn || curUrl).replace(/\/$/, '');

  const hasKey = !!current?.[name]?.apiKey;
  let apiKey = await askSecret(rl, `API key${hasKey ? ' [keep current]' : name === 'openai' ? ' (leave empty for local servers)' : ''}: `);
  if (!apiKey && hasKey) apiKey = current![name]!.apiKey!;
  if (!apiKey && name === 'anthropic') {
    console.log(c.red('An API key is required for Anthropic.'));
    return runSetup(rl, current);
  }

  console.log(c.dim('Fetching available models…'));
  const models = await listModels(name, baseUrl, apiKey || 'none');
  let model = '';
  if (models.length) {
    const shown = models.slice(0, 20);
    shown.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}) ${m}`));
    if (models.length > shown.length) console.log(c.dim(`  … ${models.length - shown.length} more; type an id to use one of them`));
    const ans = (await rl.question('Choose a model (number or id): ')).trim();
    model = /^\d+$/.test(ans) ? (shown[Number(ans) - 1] ?? '') : ans;
  } else {
    console.log(c.yellow('Could not list models from this endpoint; enter the model id manually.'));
    model = (await rl.question('Model id: ')).trim();
  }
  while (!model) model = (await rl.question('Model id (required): ')).trim();

  const cfg: MooConfig = { provider: name, model, [name]: { apiKey: apiKey || undefined, baseUrl: baseUrl === DEFAULT_URL[name] ? undefined : baseUrl } };
  const path = saveConfig(cfg);
  console.log(c.green(`Saved to ${path} (mode 600)\n`));
  return cfg;
}

/** True when no usable provider+key+model can be resolved from flags/env/file. */
export function needsSetup(cfg: MooConfig): boolean {
  const name = cfg.provider as Name | undefined;
  if (!name || !cfg.model) return true;
  return !(cfg[name]?.apiKey || (name === 'openai' && cfg.openai?.baseUrl));
}
