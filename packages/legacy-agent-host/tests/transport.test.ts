import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createHostServer, HostRpcError } from '../dist/index.js';
import { DEFAULT_HOST_LIMITS, HOST_PROTOCOL_VERSION } from '../dist/contracts.js';

import type { HostServerOptions, JsonValue } from '../dist/index.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const request = (id: number, method: string, params?: JsonValue): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

function fixture(overrides: Partial<HostServerOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  let tail = '';
  output.on('data', (chunk: Buffer) => {
    tail += chunk.toString('utf8');
    let newline: number;
    while ((newline = tail.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(tail.slice(0, newline)) as Record<string, unknown>);
      tail = tail.slice(newline + 1);
    }
  });
  const server = createHostServer({ input, output, buildId: 'TEST-transport', ...overrides });
  return { input, output, server, frames };
}

async function handshake(input: PassThrough): Promise<void> {
  input.write(request(1, 'host.handshake', { protocolVersion: HOST_PROTOCOL_VERSION }));
  await tick();
}

test('frame bound applies before parse, including fragmented UTF-8 bytes at the exact boundary', async () => {
  let calls = 0;
  const f = fixture({
    limits: { maxFrameBytes: 1024 },
    methods: {
      echo: {
        lane: 'work',
        handle: () => {
          calls++;
          return 'ok';
        },
      },
    },
  });
  await handshake(f.input);
  const base = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: '😀' });
  const exact = Buffer.from(`${base}${' '.repeat(1024 - Buffer.byteLength(base))}\n`);
  const emojiAt = exact.indexOf(Buffer.from('😀'));
  f.input.write(exact.subarray(0, emojiAt + 1));
  f.input.write(exact.subarray(emojiAt + 1));
  await tick();
  assert.equal(calls, 1);
  assert.equal(f.frames.find((frame) => frame.id === 2)?.result, 'ok');
  const oversized = Buffer.from(`${base}${' '.repeat(1025 - Buffer.byteLength(base))}\n`);
  f.input.write(oversized.subarray(0, 1024));
  assert.equal(calls, 1);
  f.input.write(oversized.subarray(1024));
  assert.equal((await f.server.closed).reason, 'frame_too_large');
  assert.equal(calls, 1, 'oversized request must not execute its handler');
});

test('malformed UTF-8 and incomplete frames close without executing a request', async () => {
  const invalid = fixture();
  invalid.input.write(Buffer.from([0xc3, 0x28, 10]));
  assert.equal((await invalid.server.closed).reason, 'invalid_utf8');
  const truncated = fixture();
  truncated.input.end('{"jsonrpc":"2.0"');
  assert.equal((await truncated.server.closed).reason, 'truncated_frame');
});

test('handshake gates handlers and method failures do not disclose private errors', async () => {
  let calls = 0;
  const f = fixture({
    methods: {
      fail: {
        lane: 'work',
        handle: () => {
          calls++;
          throw new Error('TEST-private-payload');
        },
      },
      reserved: {
        lane: 'work',
        handle: () => {
          throw new HostRpcError(-32002, 'spoofed busy');
        },
      },
      custom: {
        lane: 'work',
        handle: () => {
          throw new HostRpcError(-32010, 'TEST-sensitive-provider-token-and-payload');
        },
      },
    },
  });
  f.input.write(request(10, 'fail'));
  f.input.write(request(11, 'host.handshake', { protocolVersion: 999 }));
  await tick();
  assert.equal(calls, 0);
  assert.equal(f.frames.length, 2);
  assert.deepEqual(f.frames[0]?.error, { code: -32001, message: 'Handshake required' });
  assert.deepEqual(f.frames[1]?.error, { code: -32001, message: 'Protocol mismatch' });
  await handshake(f.input);
  f.input.write(request(12, 'missing'));
  f.input.write(request(13, 'fail'));
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(f.frames.find((frame) => frame.id === 12)?.error, {
    code: -32601,
    message: 'Method not found',
  });
  assert.deepEqual(f.frames.find((frame) => frame.id === 13)?.error, {
    code: -32603,
    message: 'Handler failed',
  });
  assert.equal(JSON.stringify(f.frames).includes('TEST-private-payload'), false);
  f.input.write(request(14, 'reserved') + request(15, 'custom'));
  await tick();
  assert.deepEqual(f.frames.find((frame) => frame.id === 14)?.error, {
    code: -32603,
    message: 'Handler failed',
  });
  assert.deepEqual(f.frames.find((frame) => frame.id === 15)?.error, {
    code: -32010,
    message: 'Operation failed',
  });
  assert.equal(
    JSON.stringify(f.frames).includes('TEST-sensitive-provider-token-and-payload'),
    false
  );
  await f.server.dispose();
});

test('reserved control capacity resolves a pending permission while prompt slots are full', async () => {
  const releases: ((value: JsonValue) => void)[] = [];
  const f = fixture({
    limits: { maxPendingRequests: 4, reservedControlRequests: 1 },
    methods: {
      prompt: {
        lane: 'work',
        handle: () =>
          new Promise((resolve) => {
            releases.push(resolve);
          }),
      },
      permission: {
        lane: 'control',
        handle: () => {
          for (const release of releases) release('terminal');
          return 'permission-resolved';
        },
      },
    },
  });
  await handshake(f.input);
  f.input.write(request(2, 'prompt') + request(3, 'prompt') + request(4, 'prompt'));
  f.input.write(request(5, 'prompt') + request(6, 'permission'));
  await tick();
  assert.equal(releases.length, 3);
  assert.deepEqual(f.frames.find((frame) => frame.id === 5)?.error, {
    code: -32002,
    message: 'Host busy',
  });
  assert.equal(f.frames.find((frame) => frame.id === 6)?.result, 'permission-resolved');
  for (const id of [2, 3, 4])
    assert.equal(f.frames.find((frame) => frame.id === id)?.result, 'terminal');
  await f.server.dispose();
});

class GateOutput extends Writable {
  readonly frames: Record<string, unknown>[] = [];
  readonly callbacks: ((error?: Error | null) => void)[] = [];
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    this.frames.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
    this.callbacks.push(callback);
  }
  async release(): Promise<void> {
    assert.ok(this.callbacks.length > 0, 'expected an in-flight bounded write');
    this.callbacks.shift()?.();
    await tick();
  }
}

test('slow data consumer receives an explicit gap and control overtakes queued data', async () => {
  const output = new GateOutput();
  const f = fixture({
    output,
    limits: { maxDataNotifications: 2, maxDataBytes: 1024, writeTimeoutMs: 1000 },
  });
  assert.equal(f.server.notifyData('delta', { sequence: 1 }), true); // in-flight
  assert.equal(f.server.notifyData('delta', { sequence: 2 }), true);
  assert.equal(f.server.notifyData('delta', { sequence: 3 }), true);
  assert.equal(f.server.notifyData('delta', { sequence: 4 }), false); // discard 2,3,4
  assert.equal(f.server.notifyData('delta', { sequence: 5 }), true);
  assert.equal(f.server.notifyControl('permission', { id: 'request-A' }), true);
  assert.equal(output.frames.length, 1, 'only one write can be in flight');
  await output.release();
  assert.equal(output.frames[1]?.method, 'permission');
  await output.release();
  assert.deepEqual(output.frames[2], {
    jsonrpc: '2.0',
    method: 'host.gap',
    params: { dropped: 3 },
  });
  await output.release();
  assert.deepEqual(output.frames[3]?.params, { sequence: 5 });
  await output.release();
  await f.server.dispose();
});

test('blocked stdout times out, seals handlers and finishes disposal even if cleanup hangs', async () => {
  const output = new GateOutput();
  let calls = 0;
  let signal: AbortSignal | undefined;
  let disposals = 0;
  const f = fixture({
    output,
    limits: { writeTimeoutMs: 20, disposeTimeoutMs: 20 },
    onDispose: () => {
      disposals++;
      return new Promise(() => {});
    },
    methods: {
      wait: {
        lane: 'work',
        handle: (_params, context) => {
          calls++;
          signal = context.signal;
          return new Promise(() => {});
        },
      },
    },
  });
  // Handshake itself is blocked at stdout; parsing/control remains live until timeout.
  f.input.write(request(1, 'host.handshake', { protocolVersion: 1 }) + request(2, 'wait'));
  const started = performance.now();
  const outcome = await f.server.closed;
  assert.deepEqual(outcome, { reason: 'write_timeout', cleanup: 'timeout' });
  assert.ok(performance.now() - started < 1000);
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
  assert.equal(disposals, 1);
  assert.equal(output.destroyed, true);
  assert.equal(f.input.destroyed, true);
  assert.deepEqual(await f.server.dispose(), outcome, 'disposal is idempotent');
});

test('priority queue exhaustion fails closed rather than dropping control or retaining unlimited responses', async () => {
  const output = new GateOutput();
  const f = fixture({ output, limits: { maxPriorityMessages: 1 } });
  assert.equal(f.server.notifyControl('control', 1), true);
  assert.equal(f.server.notifyControl('control', 2), true);
  assert.equal(f.server.notifyControl('control', 3), false);
  assert.equal((await f.server.closed).reason, 'priority_overflow');
  assert.equal(output.frames.length, 1);
});

test('actual CLI speaks NDJSON from an unrelated TEST cwd with no native/provider operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-legacy-host-'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    {
      cwd: directory,
      env: { PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const exit = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');
  try {
    child.stdin.write(request(1, 'host.handshake', { protocolVersion: 1 }));
    const [chunk] = (await once(child.stdout, 'data')) as [string];
    const response = JSON.parse(chunk.trim()) as {
      id: number;
      result: { protocolVersion: number; limits: unknown };
    };
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, 1);
    assert.deepEqual(response.result.limits, DEFAULT_HOST_LIMITS);
    child.stdin.write(request(2, 'task.create'));
    const [unknown] = (await once(child.stdout, 'data')) as [string];
    assert.deepEqual((JSON.parse(unknown.trim()) as { error: unknown }).error, {
      code: -32601,
      message: 'Method not found',
    });
    child.stdin.end();
    assert.deepEqual(await exit, [0, null]);
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual CLI exits on frame limit+1 without parsing or sending a fake outcome', async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    {
      env: { PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const exit = once(child, 'exit');
  let outputBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
  });
  child.stdin.on('error', () => {}); // remote closure is expected for a rejected frame
  child.stdin.end(Buffer.alloc(DEFAULT_HOST_LIMITS.maxFrameBytes + 1, 32));
  assert.deepEqual(await exit, [1, null]);
  assert.equal(outputBytes, 0);
});
