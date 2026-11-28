import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { createHostServer } from '../dist/index.js';
import { HostOutput } from '../dist/output.js';
import {
  DEFAULT_HOST_LIMITS,
  MAX_HOST_FRAME_BYTES,
  MAX_HOST_PRIORITY_BYTES,
  REVIEW_HOST_METHODS,
  resolveHostLimits,
  resolveHostProfileLimits,
} from '../dist/contracts.js';
import type { HostCloseReason, JsonValue } from '../dist/contracts.js';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function frame(id: number, method: string, bytes: number): Buffer {
  const base = JSON.stringify({ jsonrpc: '2.0', id, method, params: '' });
  assert.ok(bytes >= Buffer.byteLength(base));
  return Buffer.from(base + ' '.repeat(bytes - Buffer.byteLength(base)) + '\n');
}
function fixture() {
  const input = new PassThrough(),
    output = new PassThrough();
  const frames: { id: number; result?: JsonValue; error?: { code: number } }[] = [];
  let tail = '',
    effects = 0;
  output.on('data', (chunk: Buffer) => {
    tail += chunk.toString('utf8');
    let at: number;
    while ((at = tail.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(tail.slice(0, at)));
      tail = tail.slice(at + 1);
    }
  });
  const server = createHostServer({
    input,
    output,
    buildId: 'TEST-review-capacity',
    reviewTransport: 'review-v1',
    methods: {
      'team.review.invoke': {
        lane: 'work',
        handle: () => {
          effects++;
          return 'ok';
        },
      },
      ordinary: {
        lane: 'work',
        handle: () => {
          effects++;
          return 'ordinary';
        },
      },
    },
  });
  return { input, server, frames, effects: () => effects };
}
async function handshake(input: PassThrough) {
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'host.handshake',
      params: { protocolVersion: 1 },
    }) + '\n'
  );
  await tick();
}
test('review profile is explicit and finite, with two full queued frames including LF', () => {
  assert.deepEqual(resolveHostProfileLimits(), DEFAULT_HOST_LIMITS);
  const review = resolveHostProfileLimits('review-v1');
  assert.equal(review.maxFrameBytes, 32 * 1024 * 1024 + 64 * 1024);
  assert.equal(review.maxPriorityBytes, 2 * (review.maxFrameBytes + 1));
  assert.throws(() => resolveHostLimits({ maxFrameBytes: MAX_HOST_FRAME_BYTES + 1 }));
  assert.throws(() => resolveHostLimits({ maxPriorityBytes: MAX_HOST_PRIORITY_BYTES + 1 }));
  assert.throws(() => resolveHostProfileLimits(undefined, { maxFrameBytes: MAX_HOST_FRAME_BYTES }));
  assert.throws(() =>
    resolveHostProfileLimits('review-v1', { maxPriorityBytes: MAX_HOST_PRIORITY_BYTES - 1 })
  );
  assert.equal(REVIEW_HOST_METHODS.length, 10);
});
test('exact finite review request frame dispatches; limit plus one closes before another effect', async () => {
  const f = fixture();
  await handshake(f.input);
  const exact = frame(2, 'team.review.invoke', MAX_HOST_FRAME_BYTES);
  f.input.write(exact.subarray(0, 900_000));
  f.input.write(exact.subarray(900_000));
  await tick();
  assert.equal(f.effects(), 1);
  assert.equal(f.frames.find((row) => row.id === 2)?.result, 'ok');
  f.input.write(frame(3, 'team.review.invoke', MAX_HOST_FRAME_BYTES + 1));
  assert.equal((await f.server.closed).reason, 'frame_too_large');
  assert.equal(f.effects(), 1);
});
test('review opt-in retains ordinary one-MiB and rejects unknown review aliases before effects', async () => {
  const f = fixture();
  await handshake(f.input);
  f.input.write(frame(2, 'ordinary', DEFAULT_HOST_LIMITS.maxFrameBytes));
  await tick();
  assert.equal(f.effects(), 1);
  f.input.write(frame(3, 'ordinary', DEFAULT_HOST_LIMITS.maxFrameBytes + 1));
  f.input.write(frame(4, 'team.review.unbounded', DEFAULT_HOST_LIMITS.maxFrameBytes + 1));
  await tick();
  assert.equal(f.effects(), 1);
  assert.equal(f.frames.find((row) => row.id === 3)?.error?.code, -32602);
  assert.equal(f.frames.find((row) => row.id === 4)?.error?.code, -32602);
  await f.server.dispose();
});
class SlowOutput extends Writable {
  readonly callbacks: ((error?: Error | null) => void)[] = [];
  readonly frames: Buffer[] = [];
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    this.frames.push(chunk);
    this.callbacks.push(callback);
  }
}
test('slow UI retains two maximal priority frames plus one in-flight; another priority frame fails finitely', () => {
  const target = new SlowOutput(),
    reasons: HostCloseReason[] = [];
  const output = new HostOutput(target, resolveHostProfileLimits('review-v1'), (reason) =>
    reasons.push(reason)
  );
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: '' }));
  const message = {
    jsonrpc: '2.0' as const,
    id: 'x',
    result: 'x'.repeat(MAX_HOST_FRAME_BYTES - envelopeBytes),
  };
  assert.equal(output.sendPriority(message), true);
  assert.equal(output.sendPriority(message), true);
  assert.equal(output.sendPriority(message), true);
  assert.equal(target.frames.length, 1);
  assert.equal(output.sendPriority({ jsonrpc: '2.0', id: 'overflow', result: null }), false);
  assert.deepEqual(reasons, ['priority_overflow']);
  output.stop();
  target.destroy();
});
test('oversized response remains unknown transport failure and ordinary response stays bounded under review profile', () => {
  for (const bound of [MAX_HOST_FRAME_BYTES, DEFAULT_HOST_LIMITS.maxFrameBytes]) {
    const target = new SlowOutput(),
      reasons: HostCloseReason[] = [];
    const output = new HostOutput(target, resolveHostProfileLimits('review-v1'), (reason) =>
      reasons.push(reason)
    );
    assert.equal(
      output.sendPriority({ jsonrpc: '2.0', id: 'too-large', result: 'x'.repeat(bound) }, bound),
      false
    );
    assert.deepEqual(reasons, ['priority_overflow']);
    assert.equal(target.frames.length, 0);
    output.stop();
    target.destroy();
  }
});
