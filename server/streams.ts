import { once } from 'node:events';
import { requireThat } from './store.js';

export const SSE_ENVELOPE_BYTES = 256;

export async function* sseFrames(
  source: AsyncIterable<unknown>,
  limit: number,
  inspect: () => void = () => {},
): AsyncGenerator<{ event: string; data: unknown }> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of source) {
    inspect();
    requireThat(chunk instanceof Uint8Array, 'Invalid event stream', 502);
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll('\r\n', '\n');
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end < 0) break;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      requireThat(Buffer.byteLength(frame) <= limit, 'Event stream frame too large', 502);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trimStart();
        if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
      }
      if (data.length) {
        const value: unknown = JSON.parse(data.join('\n'));
        yield { event, data: value };
      }
    }
    requireThat(Buffer.byteLength(buffer) <= limit, 'Event stream frame too large', 502);
  }
  buffer += decoder.decode();
  requireThat(buffer.trim() === '', 'Event stream interrupted', 502);
}

export async function streamText(source: AsyncIterable<unknown>, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    requireThat(chunk instanceof Uint8Array, 'Invalid response stream', 502);
    size += chunk.byteLength;
    requireThat(size <= limit, 'Response stream too large', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const WRITE_INACTIVITY_MS = 5000;

export async function writeEvent(
  output: NodeJS.WritableStream,
  value: unknown,
  signal: AbortSignal,
  timeoutMs = WRITE_INACTIVITY_MS,
) {
  signal.throwIfAborted();
  if (output.write('data: ' + JSON.stringify(value) + '\n\n')) return;
  const stalled = new AbortController();
  const closed = () => stalled.abort(new Error('Event sink closed'));
  output.once('close', closed);
  const drainDeadline = setTimeout(
    () => stalled.abort(new DOMException('Stream write timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    await once(output, 'drain', { signal: AbortSignal.any([signal, stalled.signal]) });
  } finally {
    clearTimeout(drainDeadline);
    output.removeListener('close', closed);
  }
}
