import { sleep } from '../util.ts';

/** POST JSON with retry on network errors, 429 and 5xx. Returns the raw Response (for SSE). */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) return res;
      const text = await res.text();
      const err = new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 500)}`);
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw err;
    } catch (e: any) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      if (String(e?.message).startsWith('HTTP ')) throw e;
      lastErr = e;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Parse a Server-Sent-Events body into the `data:` payloads. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const sep = /\r?\n\r?\n/;
  const extract = (chunk: string) =>
    chunk
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m: RegExpExecArray | null;
    while ((m = sep.exec(buf))) {
      const data = extract(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (data) yield data;
    }
  }
  const rest = extract(buf);
  if (rest) yield rest;
}
