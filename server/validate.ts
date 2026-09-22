import { requireThat } from './store.js';

/** Non-empty string field with a byte-length ceiling. */
export function field(value: unknown, max = 256): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= max);
  return value;
}

/** Plain object (not null, not an array). */
export function record(value: unknown): Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Read a response body with a size ceiling and parse it as JSON. */
export async function boundedValue(response: Response, max = 65536): Promise<unknown> {
  requireThat(response.ok, 'Upstream rejected request');
  const reader = response.body?.getReader();
  requireThat(reader);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      requireThat(size <= max, 'Response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export const boundedJson = async (response: Response): Promise<Record<string, unknown>> =>
  record(await boundedValue(response));
