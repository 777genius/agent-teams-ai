import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';
import { SelectedControllerChannel } from './selected-controller-channel';
function frame(source: string) {
  const bytes = Buffer.from(source), value = Buffer.alloc(bytes.length + 4);
  value.writeUInt32BE(bytes.length); bytes.copy(value, 4); return value;
}
test('FD3 bounded reader retains partial frames without waiting for EOF', async () => {
  const socket = new PassThrough(), channel = new SelectedControllerChannel(socket);
  try {
    const pending = channel.read(new AbortController().signal);
    const bytes = frame('{"kind":"transition"}');
    socket.write(bytes.subarray(0, 2)); socket.write(bytes.subarray(2, 9)); socket.write(bytes.subarray(9));
    assert.deepEqual(await pending, { kind: 'transition' });
    assert(!socket.destroyed);
  } finally { channel.close(); }
});
test('duplicate keys, trailing frames and oversized declared length poison FD3', async () => {
  for (const bytes of [frame('{"a":1,"a":2}'),
    Buffer.concat([frame('{}'), frame('{}')]), Buffer.from([0xff, 0xff, 0xff, 0xff])]) {
    const socket = new PassThrough(), channel = new SelectedControllerChannel(socket);
    const pending = channel.read(new AbortController().signal);
    socket.write(bytes);
    await assert.rejects(pending, /selected_controller_closed/u);
    await assert.rejects(channel.read(new AbortController().signal));
  }
});
test('EOF in a partial frame and deadline cancel pending ownership', async () => {
  const socket = new PassThrough(), channel = new SelectedControllerChannel(socket);
  const pending = channel.read(new AbortController().signal);
  socket.end(frame('{}').subarray(0, 5));
  await assert.rejects(pending, /selected_controller_closed/u);
  const next = new SelectedControllerChannel(new PassThrough());
  await assert.rejects(next.read(new AbortController().signal, 1), /selected_controller_closed/u);
});

test('request fence remains set through the response write callback', async () => {
  let complete!: (error?: Error | null) => void;
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { complete = done; } });
  const channel = new SelectedControllerChannel(stream);
  const request = channel.read(new AbortController().signal, 5000, true);
  stream.push(frame('{}')); await request;
  const response = channel.write({ ok: true }, true);
  stream.push(frame('{}')); complete();
  await assert.rejects(response); assert(channel.closedSignal.aborted);
});
test('next exchange is admitted after the preceding response completes', async () => {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const channel = new SelectedControllerChannel(stream);
  try {
    for (let sequence = 1; sequence <= 2; sequence++) {
      const request = channel.read(new AbortController().signal, 5000, true);
      stream.push(frame(`{"sequence":${sequence}}`));
      assert.deepEqual(await request, { sequence });
      await channel.write({ sequence }, true);
    }
  } finally { channel.close(); }
});
