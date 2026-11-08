import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiProfileScope } from '../../../src/features/local-http-auth/main/infrastructure/authorityPaths';
import {
  encodeFrame,
  HELPER_MARKER,
  HelperFrames,
  parsePublicationRequest,
} from '../../../src/features/local-http-auth/main/infrastructure/publicationHelperProtocol';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock(
  '../../../src/features/local-http-auth/main/infrastructure/publicationHelperPaths',
  () => ({ resolvePublicationHelper: mocks.resolve }),
);
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}
const buildId = '11111111-1111-1111-1111-111111111111';
const request = () =>
  parsePublicationRequest({
    v: 1,
    id: randomUUID(),
    op: 'publish',
    root: '/private/profile',
    rootMode: 'existing',
    authority: {
      schemaVersion: 1,
      service: 'api',
      profileScope: apiProfileScope('/private/profile'),
      instanceId: randomUUID(),
      generation: randomUUID(),
      baseUrl: 'http://127.0.0.1:1234',
      token: 'private-token'.repeat(3),
    },
  });
const ready = (child: Child) =>
  child.stdout.write(
    encodeFrame({ v: 1, kind: 'ready', buildId, mode: 'node' }),
  );
async function setup() {
  vi.resetModules();
  mocks.resolve.mockResolvedValue({
    executable: '/exact/node',
    entry: '/app/publication-helper.cjs',
    buildId,
  });
  const child = new Child();
  mocks.spawn.mockReturnValue(child);
  const client =
    await import('../../../src/features/local-http-auth/main/infrastructure/publicationHelperClient');
  client.configurePublicationHelper({ directory: '/app', mode: 'node' });
  return { client, child };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('one-shot publication owner', () => {
  it('sends no credentials before ready and accepts final result only after physical close', async () => {
    const { client, child } = await setup();
    const input = request();
    const writes: Buffer[] = [];
    child.stdin.on('data', (chunk) => writes.push(Buffer.from(chunk)));
    let settled = false;
    const pending = client.requestPublication(input).then((value) => {
      settled = true;
      return value;
    });
    await flush();
    expect(writes).toEqual([]);
    const [executable, argv, options] = mocks.spawn.mock.calls[0];
    expect(executable).toBe('/exact/node');
    expect(options.cwd).toBe('/app');
    expect(argv).toEqual([
      '/app/publication-helper.cjs',
      HELPER_MARKER,
      'node',
    ]);
    expect(JSON.stringify(options)).not.toContain(input.authority.token);
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    ready(child);
    const frames = new HelperFrames(1);
    expect(writes.flatMap((chunk) => frames.push(chunk))).toEqual([input]);
    const stdoutEnded = new Promise<void>((resolve) =>
      child.stdout.once('end', resolve),
    );
    child.stdout.end(
      encodeFrame({
        v: 1,
        kind: 'result',
        id: input.id,
        outcome: 'published',
        code: 'none',
        hintAction: 'keep',
      }),
    );
    await stdoutEnded;
    expect(settled).toBe(false);
    child.emit('close', 0, null);
    await expect(pending).resolves.toMatchObject({ outcome: 'published' });
  });
  it('timeout rejects queued/new operations promptly while retaining exact unknown child retirement', async () => {
    vi.useFakeTimers();
    const { client, child } = await setup();
    const first = client.requestPublication(request());
    const firstFailure = expect(first).rejects.toThrow('admission closed');
    const queued = client.requestPublication(request());
    const queuedFailure = expect(queued).rejects.toThrow('admission closed');
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await firstFailure;
    await queuedFailure;
    await expect(client.requestPublication(request())).rejects.toThrow(
      'admission closed',
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    let retired = false;
    const physical = client.disposePublicationHelper().then(() => {
      retired = true;
    });
    await flush();
    expect(retired).toBe(false);
    child.emit('close', null, 'SIGTERM');
    await physical;
    expect(retired).toBe(true);
    await expect(client.requestPublication(request())).rejects.toThrow();
  });
  it('fails closed on a stderr pipe error without leaking it or terminating the unknown child', async () => {
    const { client, child } = await setup();
    const pending = client.requestPublication(request());
    const failure = expect(pending).rejects.toThrow('admission closed');
    await flush();
    expect(() =>
      child.stderr.emit('error', new Error('private-pipe-error')),
    ).not.toThrow();
    await failure;
    expect(child.kill).not.toHaveBeenCalled();
    await expect(client.requestPublication(request())).rejects.toThrow(
      'admission closed',
    );
    child.emit('close', 1, null);
  });
  it('retains one physical disposal, waits for admitted publication close, and cleans only its proven exact generation', async () => {
    vi.useFakeTimers();
    const { client, child } = await setup();
    const cleanup = new Child();
    mocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(cleanup);
    const input = request();
    const pending = client.requestPublication(input);
    await flush();
    ready(child);
    client.closePublicationAdmission();
    const disposal = client.disposePublicationHelper();
    expect(client.disposePublicationHelper()).toBe(disposal);
    const decision = client.waitForPublicationHelperRetirement(5);
    await vi.advanceTimersByTimeAsync(5);
    await expect(decision).resolves.toBe('pending');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    const firstEnd = new Promise<void>((resolve) =>
      child.stdout.once('end', resolve),
    );
    child.stdout.end(
      encodeFrame({
        v: 1,
        kind: 'result',
        id: input.id,
        outcome: 'published',
        code: 'none',
        hintAction: 'keep',
      }),
    );
    await firstEnd;
    child.emit('close', 0, null);
    await pending;
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const sent: Buffer[] = [];
    cleanup.stdin.on('data', (chunk) => sent.push(Buffer.from(chunk)));
    ready(cleanup);
    const decoded = sent.flatMap((chunk) => new HelperFrames(1).push(chunk));
    expect(decoded).toHaveLength(1);
    const removal = parsePublicationRequest(decoded[0]);
    expect(removal.op).toBe('remove');
    expect(removal.authority).toEqual(input.authority);
    expect(removal.root).toBe(input.root);
    const cleanupEnd = new Promise<void>((resolve) =>
      cleanup.stdout.once('end', resolve),
    );
    cleanup.stdout.end(
      encodeFrame({
        v: 1,
        kind: 'result',
        id: removal.id,
        outcome: 'removed',
        code: 'none',
        hintAction: 'revoke-matching',
      }),
    );
    await cleanupEnd;
    cleanup.emit('close', 0, null);
    await disposal;
    await expect(client.waitForPublicationHelperRetirement(5)).resolves.toBe(
      'closed',
    );
    await expect(client.requestPublication(request())).rejects.toThrow(
      'admission closed',
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(cleanup.kill).not.toHaveBeenCalled();
  });
  it('consumes cleanup eligibility on an admitted normal remove, even if that remove has unknown outcome', async () => {
    vi.useFakeTimers();
    const { client, child } = await setup();
    const removing = new Child();
    mocks.spawn.mockReturnValueOnce(child).mockReturnValueOnce(removing);
    const input = request();
    const published = client.requestPublication(input);
    await flush();
    ready(child);
    const ended = new Promise<void>((resolve) =>
      child.stdout.once('end', resolve),
    );
    child.stdout.end(
      encodeFrame({
        v: 1,
        kind: 'result',
        id: input.id,
        outcome: 'published',
        code: 'none',
        hintAction: 'keep',
      }),
    );
    await ended;
    child.emit('close', 0, null);
    await published;
    const removal = client.requestPublication({ ...input, op: 'remove' });
    const rejected = expect(removal).rejects.toThrow('admission closed');
    await flush();
    ready(removing);
    client.closePublicationAdmission();
    const disposal = client.disposePublicationHelper();
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    removing.emit('close', 1, null);
    await disposal;
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(removing.kill).not.toHaveBeenCalled();
  });
  it('does not remint older publication cleanup eligibility after a queued normal remove was already admitted', async () => {
    const { client, child } = await setup();
    const input = request();
    const pending = client.requestPublication(input);
    await flush();
    ready(child);
    const queued = client.requestPublication({ ...input, op: 'remove' });
    const rejected = expect(queued).rejects.toThrow('admission closed');
    client.closePublicationAdmission();
    const disposal = client.disposePublicationHelper();
    const ended = new Promise<void>((resolve) =>
      child.stdout.once('end', resolve),
    );
    child.stdout.end(
      encodeFrame({
        v: 1,
        kind: 'result',
        id: input.id,
        outcome: 'published',
        code: 'none',
        hintAction: 'keep',
      }),
    );
    await ended;
    child.emit('close', 0, null);
    await pending;
    await rejected;
    await disposal;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('does not replay a committed operation when final delivery is truncated', async () => {
    const { client, child } = await setup();
    const pending = client.requestPublication(request());
    const failure = expect(pending).rejects.toThrow('admission closed');
    await flush();
    ready(child);
    child.stdout.end(Buffer.from([0, 0, 0, 10, 123]));
    await flush();
    await failure;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    child.emit('close', 1, null);
  });
});
