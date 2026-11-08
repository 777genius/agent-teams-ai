// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({ open: vi.fn(), probe: vi.fn() }));
vi.mock('node:fs/promises', () => ({ open: ports.open }));
vi.mock('@main/services/runtime/openCodeNativeProbe', () => ({
  runOpenCodeNativeProbe: ports.probe,
  isNativeProbeFatal: (error: unknown) => error instanceof Error && error.message === 'TEST-fatal',
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  ports.open.mockReset();
  ports.probe.mockReset();
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
});

function image(interpreter: string): Buffer {
  const value = Buffer.from(`${interpreter}\0`);
  const bytes = Buffer.alloc(128 + value.length);
  Buffer.from('7f454c46', 'hex').copy(bytes);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(62, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(3, 64);
  bytes.writeBigUInt64LE(128n, 72);
  bytes.writeBigUInt64LE(BigInt(value.length), 96);
  value.copy(bytes, 128);
  return bytes;
}
function file(bytes: Buffer) {
  return {
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: bytes.copy(target, offset, position, Math.min(bytes.length, position + length)),
    })),
    close: vi.fn(async () => undefined),
  };
}
function kernelFiles(executable: () => ReturnType<typeof file>) {
  ports.open.mockImplementation(async (name: string) => {
    if (name === '/proc/self/exe') return executable();
    if (name === '/proc/self/maps') return file(Buffer.alloc(0));
    if (name === '/proc/cpuinfo') return file(Buffer.from('flags : avx2 sse2\n'));
    throw new Error('Unexpected fixture read');
  });
}

it.each([
  ['glibc', '/lib64/ld-linux-x86-64.so.2'],
  ['musl', '/lib/ld-musl-x86_64.so.1'],
] as const)(
  'retries resolved Linux unknown evidence and retains the next known %s acquisition',
  async (libc, interpreter) => {
    const held = file(image('/lib64/ld-linux-x86-64.so.2'));
    const readHeader = held.read.getMockImplementation()!;
    let finishHeader!: () => Promise<void>;
    held.read.mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          finishHeader = async () => {
            resolve(await readHeader(...args));
          };
        })
    );
    let images = 0;
    kernelFiles(() => (++images === 1 ? held : file(image(interpreter))));
    const { detectOpenCodeNativeFacts } =
      await import('@main/services/runtime/openCodeNativePlatform');
    const first = detectOpenCodeNativeFacts();
    const coalesced = detectOpenCodeNativeFacts();
    await vi.advanceTimersByTimeAsync(3500);
    expect(await first).toMatchObject({ platform: 'linux', libc: 'unknown', avx2: 'yes' });
    expect(await coalesced).toMatchObject({ libc: 'unknown' });
    expect(images).toBe(1);
    expect(await detectOpenCodeNativeFacts()).toMatchObject({ libc });
    expect(images).toBe(2);
    // A timed-out read may finish later, but cannot overwrite the newer cached result.
    await finishHeader();
    await vi.runAllTimersAsync();
    expect(await detectOpenCodeNativeFacts()).toMatchObject({ libc });
    expect(images).toBe(2);
    expect(ports.probe).not.toHaveBeenCalled();
  }
);

it('does not let an old unknown result evict a replacement cache acquisition', async () => {
  let cache: Map<string, Promise<unknown>> | undefined;
  const originalSet = Map.prototype.set;
  const capture = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value
  ) {
    if (key === 'linux/x64' && value instanceof Promise)
      cache = this as Map<string, Promise<unknown>>;
    return originalSet.call(this, key, value);
  });
  const held = file(image('/lib64/ld-linux-x86-64.so.2'));
  let finishHeader!: () => Promise<void>;
  const readHeader = held.read.getMockImplementation()!;
  held.read.mockImplementationOnce(
    (...args) =>
      new Promise((resolve) => {
        finishHeader = async () => {
          resolve(await readHeader(...args));
        };
      })
  );
  kernelFiles(() => held);
  const { detectOpenCodeNativeFacts } =
    await import('@main/services/runtime/openCodeNativePlatform');
  const old = detectOpenCodeNativeFacts();
  capture.mockRestore();
  expect(cache).toBeDefined();
  let resolveReplacement!: (value: unknown) => void;
  const replacement = new Promise((resolve) => {
    resolveReplacement = resolve;
  });
  cache!.set('linux/x64', replacement);
  await vi.advanceTimersByTimeAsync(3500);
  expect(await old).toMatchObject({ libc: 'unknown' });
  const next = detectOpenCodeNativeFacts();
  resolveReplacement({ platform: 'linux', arch: 'x64', libc: 'musl', avx2: 'yes' });
  expect(await next).toMatchObject({ libc: 'musl' });
  expect(ports.open.mock.calls.filter(([name]) => name === '/proc/self/exe')).toHaveLength(1);
  await finishHeader();
  await vi.runAllTimersAsync();
});

it.each([false, true])(
  'retains non-Linux unknown facts without replaying an OS probe (rejected=%s)',
  async (rejected) => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    if (rejected) ports.probe.mockRejectedValue(new Error('TEST-nonfatal'));
    else ports.probe.mockResolvedValue('unrecognized');
    const { detectOpenCodeNativeFacts } =
      await import('@main/services/runtime/openCodeNativePlatform');
    expect(await detectOpenCodeNativeFacts()).toMatchObject({ libc: null, avx2: 'unknown' });
    expect(await detectOpenCodeNativeFacts()).toMatchObject({ libc: null, avx2: 'unknown' });
    expect(ports.probe).toHaveBeenCalledOnce();
    expect(ports.open).not.toHaveBeenCalled();
  }
);

it('joins a non-Linux probe through terminal rejection and never evicts or replays its fatal promise', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  const failure = new Error('TEST-fatal');
  let rejectProbe!: (error: Error) => void;
  ports.probe.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectProbe = reject;
      })
  );
  const { detectOpenCodeNativeFacts } =
    await import('@main/services/runtime/openCodeNativePlatform');
  const first = detectOpenCodeNativeFacts(),
    second = detectOpenCodeNativeFacts();
  const outcomes = Promise.allSettled([first, second]);
  let settled = false;
  void outcomes.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(settled).toBe(false);
  expect(ports.probe).toHaveBeenCalledOnce();
  rejectProbe(failure);
  expect(await outcomes).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  await expect(detectOpenCodeNativeFacts()).rejects.toBe(failure);
  expect(ports.probe).toHaveBeenCalledOnce();
  expect(ports.open).not.toHaveBeenCalled();
});
