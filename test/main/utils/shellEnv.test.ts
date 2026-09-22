// @vitest-environment node
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  spawn: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: hoisted.spawn,
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getHomeDir: () => '/Users/tester',
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    warn: hoisted.loggerWarn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  kill = vi.fn();
}

function createChild(): MockChildProcess {
  return new MockChildProcess();
}

function emitEnv(child: MockChildProcess, env: Record<string, string>): void {
  const dump = `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\0')}\0`;
  child.stdout.emit('data', Buffer.from(dump));
  child.emit('close', 0);
}

function emitEnvChunks(child: MockChildProcess, chunks: string[]): void {
  for (const chunk of chunks) {
    child.stdout.emit('data', Buffer.from(chunk));
  }
  child.emit('close', 0);
}

function emitError(child: MockChildProcess, message: string): void {
  child.emit('error', new Error(message));
}

function emitClose(child: MockChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  child.emit('close', code, signal);
}

async function importShellEnv(): Promise<typeof import('@main/utils/shellEnv')> {
  return import('@main/utils/shellEnv');
}

describe('shellEnv', () => {
  const originalPlatform = process.platform;
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SHELL = '/bin/zsh';
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
      writable: true,
    });
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  });

  it('keeps the strict resolver login then interactive fallback order', async () => {
    const children: MockChildProcess[] = [];
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      children.push(child);
      queueMicrotask(() => {
        if (children.length === 1) {
          emitError(child, 'login failed');
        } else {
          emitEnv(child, { PATH: '/interactive/bin', HOME: '/Users/tester' });
        }
      });
      return child;
    });

    const shellEnv = await importShellEnv();

    await expect(shellEnv.resolveInteractiveShellEnv()).resolves.toMatchObject({
      PATH: '/interactive/bin',
      HOME: '/Users/tester',
    });
    expect(hoisted.spawn).toHaveBeenCalledTimes(2);
    expect(hoisted.spawn).toHaveBeenNthCalledWith(
      1,
      '/bin/zsh',
      ['-lic', 'env -0'],
      expect.objectContaining({ windowsHide: true })
    );
    expect(hoisted.spawn).toHaveBeenNthCalledWith(
      2,
      '/bin/zsh',
      ['-ic', 'env -0'],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it('adds a sanitized source label to strict shell failure diagnostics', async () => {
    const children: MockChildProcess[] = [];
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      children.push(child);
      const attempt = children.length;
      queueMicrotask(() => {
        emitError(child, attempt === 1 ? 'login blocked' : 'interactive blocked');
      });
      return child;
    });

    const progress = vi.fn();
    const shellEnv = await importShellEnv();

    await expect(
      shellEnv.resolveInteractiveShellEnv({
        source: ' mcp node/runtime ',
        onProgress: progress,
      })
    ).resolves.toEqual({});

    expect(progress).toHaveBeenCalledWith({
      phase: 'shell-env-login',
      message: 'Reading login shell environment...',
      source: 'mcp_node_runtime',
    });
    expect(progress).toHaveBeenCalledWith({
      phase: 'shell-env-interactive',
      message: 'Trying interactive shell environment...',
      source: 'mcp_node_runtime',
    });
    expect(progress).toHaveBeenCalledWith({
      phase: 'shell-env-fallback',
      message: 'Using current process environment...',
      source: 'mcp_node_runtime',
    });
    expect(hoisted.loggerWarn).toHaveBeenCalledWith(
      'Failed to resolve shell env after login and interactive probes source=mcp_node_runtime: login=login blocked; interactive=interactive blocked'
    );
  });

  it('returns fallback on soft timeout without caching it, then caches background success', async () => {
    const children: MockChildProcess[] = [];
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      children.push(child);
      return child;
    });

    const shellEnv = await importShellEnv();
    const fallbackEnv = { PATH: '/fallback/bin', HOME: '/fallback' };
    const result = shellEnv.resolveInteractiveShellEnvBestEffort({
      timeoutMs: 10,
      fallbackEnv,
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe(fallbackEnv);
    expect(shellEnv.getCachedShellEnv()).toBeNull();
    expect(hoisted.spawn).toHaveBeenCalledTimes(1);

    emitEnv(children[0], { PATH: '/real/bin', HOME: '/Users/tester' });
    await Promise.resolve();
    await Promise.resolve();

    expect(shellEnv.getCachedShellEnv()).toMatchObject({
      PATH: '/real/bin',
      HOME: '/Users/tester',
    });
  });

  it('returns real env when shell resolves before the soft timeout', async () => {
    const child = createChild();
    hoisted.spawn.mockReturnValueOnce(child);

    const shellEnv = await importShellEnv();
    const result = shellEnv.resolveInteractiveShellEnvBestEffort({
      timeoutMs: 100,
      fallbackEnv: { PATH: '/fallback/should-not-win' },
    });

    emitEnv(child, { PATH: '/fast/bin', HOME: '/Users/tester' });

    await expect(result).resolves.toMatchObject({
      PATH: '/fast/bin',
      HOME: '/Users/tester',
    });
    expect(shellEnv.getCachedShellEnv()).toMatchObject({
      PATH: '/fast/bin',
      HOME: '/Users/tester',
    });
  });

  it('does not let a soft fallback override getShellPreferredHome before cache warms', async () => {
    const child = createChild();
    hoisted.spawn.mockReturnValueOnce(child);

    const shellEnv = await importShellEnv();
    const result = shellEnv.resolveInteractiveShellEnvBestEffort({
      timeoutMs: 5,
      fallbackEnv: { PATH: '/fallback/bin', HOME: '/fallback-home' },
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toMatchObject({ HOME: '/fallback-home' });
    expect(shellEnv.getCachedShellEnv()).toBeNull();
    expect(shellEnv.getShellPreferredHome()).toBe('/Users/tester');

    emitEnv(child, { PATH: '/real/bin', HOME: '/real-home' });
    await Promise.resolve();
    await Promise.resolve();

    expect(shellEnv.getShellPreferredHome()).toBe('/real-home');
  });

  it('parses chunked env output and ignores malformed records', async () => {
    const child = createChild();
    hoisted.spawn.mockReturnValueOnce(child);

    const shellEnv = await importShellEnv();
    const result = shellEnv.resolveInteractiveShellEnv();

    emitEnvChunks(child, [
      'PATH=/chunk',
      'ed/bin\0',
      'MALFORMED\0',
      '=bad\0',
      'EMPTY=\0',
      'HOME=/Users/tester\0',
    ]);

    await expect(result).resolves.toMatchObject({
      PATH: '/chunked/bin',
      EMPTY: '',
      HOME: '/Users/tester',
    });
    expect(shellEnv.getCachedShellEnv()).toMatchObject({
      PATH: '/chunked/bin',
      HOME: '/Users/tester',
    });
  });

  it('starts background resolution even with a zero soft timeout', async () => {
    const children: MockChildProcess[] = [];
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      children.push(child);
      return child;
    });

    const shellEnv = await importShellEnv();
    const fallbackEnv = { PATH: '/fallback/zero' };

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 0,
        fallbackEnv,
      })
    ).resolves.toBe(fallbackEnv);

    expect(hoisted.spawn).toHaveBeenCalledTimes(1);
    expect(shellEnv.getCachedShellEnv()).toBeNull();

    emitEnv(children[0], { PATH: '/real/zero', HOME: '/Users/tester' });
    await Promise.resolve();
    await Promise.resolve();

    expect(shellEnv.getCachedShellEnv()).toMatchObject({
      PATH: '/real/zero',
      HOME: '/Users/tester',
    });
  });

  it('can return fallback without starting a background shell probe', async () => {
    const shellEnv = await importShellEnv();
    const fallbackEnv = { PATH: '/fallback/no-background' };

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 0,
        fallbackEnv,
        background: false,
      })
    ).resolves.toBe(fallbackEnv);

    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(shellEnv.getCachedShellEnv()).toBeNull();
  });

  it('keeps resolving in the background through the strict interactive fallback', async () => {
    const children: MockChildProcess[] = [];
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      children.push(child);
      return child;
    });

    const shellEnv = await importShellEnv();
    const fallbackEnv = { PATH: '/fallback/login-timeout' };
    const result = shellEnv.resolveInteractiveShellEnvBestEffort({
      timeoutMs: 10,
      fallbackEnv,
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe(fallbackEnv);
    expect(children).toHaveLength(1);

    emitError(children[0], 'login failed');
    await Promise.resolve();
    await Promise.resolve();
    expect(children).toHaveLength(2);

    emitEnv(children[1], { PATH: '/interactive/bin', HOME: '/Users/tester' });
    await Promise.resolve();
    await Promise.resolve();

    expect(shellEnv.getCachedShellEnv()).toMatchObject({
      PATH: '/interactive/bin',
      HOME: '/Users/tester',
    });
  });

  it('treats non-zero shell exit with no env output as a failed probe', async () => {
    const children: MockChildProcess[] = [];
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      children.push(child);
      queueMicrotask(() => {
        if (children.length === 1) {
          emitClose(child, 42, null);
        } else {
          emitEnv(child, { PATH: '/interactive-after-exit/bin', HOME: '/Users/tester' });
        }
      });
      return child;
    });

    const shellEnv = await importShellEnv();

    await expect(shellEnv.resolveInteractiveShellEnv()).resolves.toMatchObject({
      PATH: '/interactive-after-exit/bin',
      HOME: '/Users/tester',
    });
    expect(hoisted.spawn).toHaveBeenCalledTimes(2);
    expect(hoisted.loggerWarn).not.toHaveBeenCalled();
  });

  it('coalesces concurrent best-effort calls behind one shell process', async () => {
    const children: MockChildProcess[] = [];
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      children.push(child);
      return child;
    });

    const shellEnv = await importShellEnv();
    const firstFallback = { PATH: '/fallback/one' };
    const secondFallback = { PATH: '/fallback/two' };

    const first = shellEnv.resolveInteractiveShellEnvBestEffort({
      timeoutMs: 5,
      fallbackEnv: firstFallback,
    });
    const second = shellEnv.resolveInteractiveShellEnvBestEffort({
      timeoutMs: 5,
      fallbackEnv: secondFallback,
    });

    await vi.advanceTimersByTimeAsync(5);

    await expect(first).resolves.toBe(firstFallback);
    await expect(second).resolves.toBe(secondFallback);
    expect(hoisted.spawn).toHaveBeenCalledTimes(1);

    emitEnv(children[0], { PATH: '/real/bin' });
    await Promise.resolve();
    await Promise.resolve();
  });

  it('uses failure cooldown after a hard shell failure and avoids respawning immediately', async () => {
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      const callNumber = hoisted.spawn.mock.calls.length;
      queueMicrotask(() => emitError(child, `failure ${callNumber}`));
      return child;
    });

    const shellEnv = await importShellEnv();
    const firstFallback = { PATH: '/fallback/first' };
    const secondFallback = { PATH: '/fallback/second' };

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1_000,
        fallbackEnv: firstFallback,
      })
    ).resolves.toBe(firstFallback);
    expect(hoisted.spawn).toHaveBeenCalledTimes(2);

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1_000,
        fallbackEnv: secondFallback,
      })
    ).resolves.toBe(secondFallback);
    expect(hoisted.spawn).toHaveBeenCalledTimes(2);
  });

  it('expires failure cooldown so a later best-effort call can retry shell resolution', async () => {
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => emitError(child, 'blocked'));
      return child;
    });

    const shellEnv = await importShellEnv();

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1_000,
        fallbackEnv: { PATH: '/fallback/first' },
      })
    ).resolves.toMatchObject({ PATH: '/fallback/first' });
    expect(hoisted.spawn).toHaveBeenCalledTimes(2);

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1_000,
        fallbackEnv: { PATH: '/fallback/cooldown' },
      })
    ).resolves.toMatchObject({ PATH: '/fallback/cooldown' });
    expect(hoisted.spawn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_001);

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1_000,
        fallbackEnv: { PATH: '/fallback/retry' },
      })
    ).resolves.toMatchObject({ PATH: '/fallback/retry' });
    expect(hoisted.spawn).toHaveBeenCalledTimes(4);
  });

  it('terminates stuck login and interactive shell probes before returning fallback', async () => {
    const children: MockChildProcess[] = [];
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      children.push(child);
      return child;
    });

    const shellEnv = await importShellEnv();
    const result = shellEnv.resolveInteractiveShellEnvBestEffort({
      timeoutMs: 30_000,
      fallbackEnv: { PATH: '/fallback/stuck' },
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(children).toHaveLength(2);
    expect(children[0].kill).toHaveBeenCalledWith();

    await vi.advanceTimersByTimeAsync(12_000);

    await expect(result).resolves.toMatchObject({ PATH: '/fallback/stuck' });
    expect(children[1].kill).toHaveBeenCalledWith();
    expect(shellEnv.getCachedShellEnv()).toBeNull();
    expect(hoisted.loggerWarn).toHaveBeenCalledWith(
      'Failed to resolve shell env after login and interactive probes: login=shell env resolve timeout; interactive=shell env resolve timeout'
    );

    await vi.advanceTimersByTimeAsync(3_000);

    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(children[1].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('clears failure cooldown when the shell env cache is cleared', async () => {
    let fail = true;
    hoisted.spawn.mockImplementation(() => {
      const child = createChild();
      queueMicrotask(() => {
        if (fail) {
          emitError(child, 'blocked');
        } else {
          emitEnv(child, { PATH: '/recovered/bin', HOME: '/Users/tester' });
        }
      });
      return child;
    });

    const shellEnv = await importShellEnv();

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1_000,
        fallbackEnv: { PATH: '/fallback/blocked' },
      })
    ).resolves.toMatchObject({ PATH: '/fallback/blocked' });
    expect(hoisted.spawn).toHaveBeenCalledTimes(2);

    fail = false;
    shellEnv.clearShellEnvCache();

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1_000,
        fallbackEnv: { PATH: '/fallback/recovered' },
      })
    ).resolves.toMatchObject({
      PATH: '/recovered/bin',
      HOME: '/Users/tester',
    });
    expect(hoisted.spawn).toHaveBeenCalledTimes(3);
  });

  it('uses cached shell env immediately without spawning or returning fallback', async () => {
    const firstChild = createChild();
    hoisted.spawn.mockReturnValueOnce(firstChild);

    const shellEnv = await importShellEnv();
    const strictResult = shellEnv.resolveInteractiveShellEnv();
    emitEnv(firstChild, { PATH: '/cached/bin', HOME: '/Users/tester' });
    await expect(strictResult).resolves.toMatchObject({ PATH: '/cached/bin' });

    hoisted.spawn.mockClear();
    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1,
        fallbackEnv: { PATH: '/fallback/should-not-win' },
      })
    ).resolves.toMatchObject({
      PATH: '/cached/bin',
      HOME: '/Users/tester',
    });
    expect(hoisted.spawn).not.toHaveBeenCalled();
  });

  it('strict resolver also returns cached shell env without spawning again', async () => {
    const firstChild = createChild();
    hoisted.spawn.mockReturnValueOnce(firstChild);

    const shellEnv = await importShellEnv();
    const first = shellEnv.resolveInteractiveShellEnv();
    emitEnv(firstChild, { PATH: '/strict-cached/bin', HOME: '/Users/tester' });
    await expect(first).resolves.toMatchObject({ PATH: '/strict-cached/bin' });

    hoisted.spawn.mockClear();
    await expect(shellEnv.resolveInteractiveShellEnv()).resolves.toMatchObject({
      PATH: '/strict-cached/bin',
      HOME: '/Users/tester',
    });
    expect(hoisted.spawn).not.toHaveBeenCalled();
  });

  it('best-effort on win32 preserves the strict no-spawn behavior', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
      writable: true,
    });

    const shellEnv = await importShellEnv();

    await expect(
      shellEnv.resolveInteractiveShellEnvBestEffort({
        timeoutMs: 1,
        fallbackEnv: { PATH: '/fallback/win32' },
      })
    ).resolves.toEqual({});
    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(shellEnv.getCachedShellEnv()).toEqual({});
  });
});
