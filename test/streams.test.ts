import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { writeEvent } from '../server/streams.js';

await test('an unread event sink releases its pending write after inactivity', async () => {
  const sink = new PassThrough({ highWaterMark: 1 });
  try {
    await assert.rejects(
      writeEvent(sink, { message: 'bounded output' }, new AbortController().signal, 20),
    );
  } finally {
    sink.destroy();
  }
});
