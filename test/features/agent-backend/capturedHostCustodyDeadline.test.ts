// @vitest-environment node
import { performance } from 'node:perf_hooks';

import { DEFAULT_HOST_LIMITS } from '@agent-teams/legacy-agent-host/contracts';
import { HostCustodyClient, hostCustodyRequestSchema } from '@agent-teams/legacy-agent-host/owned-process';
import { afterEach, expect, it, vi } from 'vitest';

import { CapturedHostClient } from '../../../src/features/agent-backend/main/infrastructure/CapturedHostClient';

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks(); vi.useRealTimers();
});

/** Real custody/transport methods; TEST ports hold bytes and count effects without native authority. */
function fixture(options: { sendable?: boolean; holdReplies?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let clock = 10_000, side: 'host' | 'main' = 'main';
  let afterLocal = 0, afterShared = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    const value = clock - (side === 'host' ? 9000 : 1000); clock += afterLocal; afterLocal = 0; return value;
  });
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => {
    const value = BigInt(clock) * 1_000_000n; clock += afterShared; afterShared = 0; return value;
  });
  const asHost = <T>(action: () => T): T => {
    const previous = side; side = 'host';
    try { return action(); } finally { side = previous; }
  };
  const binding = { mainEpoch: 'TEST-main', hostIncarnation: 'TEST-host', profileDigest: '1'.repeat(64) };
  const sent: unknown[] = [];
  let sendable = options.sendable ?? true;
  const host = new HostCustodyClient({ hostIncarnation: binding.hostIncarnation,
    limits: { ...DEFAULT_HOST_LIMITS }, timeoutMs: 2000,
    send(frame) { sent.push(structuredClone(frame)); return true; }, canSend: () => sendable });
  expect(host.bind(binding)).toBe(true);
  const client = new CapturedHostClient({ profileId: 'TEST-profile', nodeExecutable: '/TEST/node',
    nodeVersion: 'v24.21.0', nodeSha256: '1'.repeat(64), hostEntry: '/TEST/host.mjs',
    hostEntrySha256: '2'.repeat(64), expectedBuildId: 'TEST-host-v1', cwd: '/TEST',
    env: { HOME: '/TEST' }, startupTimeoutMs: 3000, requestTimeoutMs: 3000,
    writeTimeoutMs: 500, shutdownTimeoutMs: 100 });
  type Internals = {
    nativeBinding: typeof binding;
    nativePort: { handle(call: { operation: string }): unknown; onReadable(): () => void };
    child: { stdin: { destroyed: boolean; write(chunk: Buffer, callback: () => void): boolean } };
    receiveNative(value: unknown, bytes: number): void;
    writeFrame(frame: Buffer, control: boolean): boolean;
    sealNative(): void;
  };
  const main = client as unknown as Internals;
  let effects = 0, release: (() => void) | undefined;
  const replies: unknown[] = [];
  main.nativeBinding = binding;
  main.nativePort = { onReadable: () => () => {}, handle(call) {
    expect(call.operation).toBe('write'); effects++;
    return { operation: 'write', state: 'completed' };
  } };
  main.child = { stdin: { destroyed: false, write(chunk, callback) {
    if (chunk[0] === 120) { release = callback; return false; }
    const reply: unknown = JSON.parse(chunk.toString('utf8'));
    replies.push(reply);
    if (!options.holdReplies) asHost(() => host.receive(reply, chunk.length - 1));
    callback(); return true;
  } } };
  expect(main.writeFrame(Buffer.alloc(DEFAULT_HOST_LIMITS.maxFrameBytes - 2048, 120), false)).toBe(true);
  disposals.push(() => { release?.(); main.sealNative(); host.seal(); });
  return {
    sent, replies, effects: () => effects,
    nativeEntries: () => Object.getOwnPropertyDescriptor(client, 'nativePending')?.value as Map<unknown, unknown>,
    hostEntries: () => Object.getOwnPropertyDescriptor(host, 'pending')?.value as Map<unknown, unknown>,
    request: () => asHost(() => host.request({ operation: 'write', capability: 'TEST-original', bytes: 'YQ==' }, performance.now() + 20)),
    requestWithLocalSamplePause: (ms: number) => asHost(() => {
      const deadline = performance.now() + 20; afterLocal = ms;
      return host.request({ operation: 'write', capability: 'TEST-original', bytes: 'YQ==' }, deadline);
    }),
    deliver: (frame = sent[0]) => main.receiveNative(frame, Buffer.byteLength(JSON.stringify(frame))),
    release: () => { const callback = release; release = undefined; callback?.(); },
    resume: () => { sendable = true; asHost(() => host.resumeAdmission()); },
    receiveReply: () => asHost(() => host.receive(replies[0], Buffer.byteLength(JSON.stringify(replies[0])))),
    advanceClockOnly(ms: number) { clock += ms; },
    advanceTimersOnly: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    pauseAfterNextSharedSample(ms: number) { afterShared = ms; },
    async advance(ms: number) { clock += ms; await vi.advanceTimersByTimeAsync(ms); },
  };
}

it.each([10, 30])('refuses native effect after original 20ms cutoff with %sms of delivery delay', async delay => {
  const f = fixture(); const requested = f.request();
  await f.advance(delay); f.deliver();
  if (delay < 20) await f.advance(20 - delay);
  expect(await requested).toEqual({ status: 'unknown' });
  expect(f.effects()).toBe(0);
  f.release();
  expect(f.effects(), 'No native effect after the original Host cutoff').toBe(0);
});

it('admits one original native effect before the unchanged cutoff', async () => {
  const f = fixture(); const requested = f.request();
  await f.advance(1); f.deliver();
  expect(f.effects()).toBe(0);
  await f.advance(9); f.release();
  expect(await requested).toEqual({ status: 'completed', value: { operation: 'write', state: 'completed' } });
  expect(f.effects()).toBe(1);
});

it('preserves the initial cutoff through Host admission queue and Main delivery', async () => {
  const f = fixture({ sendable: false }); const requested = f.request();
  expect(f.sent).toHaveLength(0);
  await f.advance(10); f.resume();
  expect(f.sent).toHaveLength(1);
  await f.advance(10); f.deliver();
  expect(await requested).toEqual({ status: 'unknown' });
  f.release(); expect(f.effects()).toBe(0);
});

it('does not renew the Host cutoff during a pause between its two clock samples', () => {
  const f = fixture(); void f.requestWithLocalSamplePause(10);
  const frame = hostCustodyRequestSchema.parse(f.sent[0]);
  expect(BigInt(frame.params.expiresAtNs)).toBeLessThanOrEqual(10_020_000_000n);
});

it('refuses after a pause between the Main receipt clock samples reaches the original cutoff', async () => {
  const f = fixture(); const requested = f.request();
  await f.advance(10); f.pauseAfterNextSharedSample(10); f.deliver(); f.release();
  expect(await requested).toMatchObject({ status: expect.stringMatching(/^(unknown|refused)$/u) });
  expect(f.effects()).toBe(0);
});

it('retains the original remainingMs bound when it is earlier than the shared expiry', async () => {
  const f = fixture(); const requested = f.request();
  const frame = hostCustodyRequestSchema.parse(f.sent[0]);
  frame.params.remainingMs = 2;
  await f.advance(1); f.deliver(frame);
  await f.advance(2); f.release();
  expect(await requested).toEqual({ status: 'refused' });
  expect(f.effects()).toBe(0);
});

it('keeps a caller pending when its rounded timer fires before the original shared cutoff', async () => {
  const f = fixture(); const requested = f.request();
  let returned = false; void requested.then(() => { returned = true; });
  await f.advanceTimersOnly(20);
  expect(returned).toBe(false);
  await f.advance(20);
  expect(await requested).toEqual({ status: 'unknown' });
  f.deliver(); f.release(); expect(f.effects()).toBe(0);
});

it('retires a late valid ACK without reporting timely completion when the expiry timer is delayed', async () => {
  const f = fixture({ holdReplies: true }); const requested = f.request();
  f.deliver(); f.release();
  await f.advanceTimersOnly(0);
  expect(f.effects()).toBe(1); expect(f.replies).toHaveLength(1);
  expect(f.hostEntries().size).toBe(1);
  f.advanceClockOnly(25); f.receiveReply();
  expect(await requested).toEqual({ status: 'unknown' });
  expect(f.hostEntries().size).toBe(0);
  f.receiveReply(); expect(f.effects()).toBe(1);
});

it.each([undefined, 10_020_000_000, '', '0', '-1', '01', '1.5', '1e9',
  '18446744073709551616', '9'.repeat(21)])('refuses a missing or invalid shared expiry %s before Main admission', expiry => {
  const f = fixture(); void f.request();
  const frame = hostCustodyRequestSchema.parse(f.sent[0]);
  const params: Record<string, unknown> = { ...frame.params };
  if (expiry === undefined) delete params.expiresAtNs;
  else params.expiresAtNs = expiry;
  expect(() => f.deliver({ ...frame, params })).toThrow('Native request');
  expect(f.nativeEntries().size).toBe(0);
  f.release(); expect(f.effects()).toBe(0);
});

it.each(['extra-field', 'foreign-binding'] as const)('preserves closed admission for %s', change => {
  const f = fixture(); void f.request();
  const frame = hostCustodyRequestSchema.parse(f.sent[0]);
  const params = change === 'extra-field' ? { ...frame.params, renew: true }
    : { ...frame.params, binding: { ...frame.params.binding, mainEpoch: 'TEST-foreign' } };
  expect(() => f.deliver({ ...frame, params })).toThrow('Native request');
  expect(f.nativeEntries().size).toBe(0);
  f.release(); expect(f.effects()).toBe(0);
});
