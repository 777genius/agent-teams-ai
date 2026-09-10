import { beforeEach, describe, expect, it, vi } from 'vitest';

type WindowsProcessTableModule = typeof import('../../../src/main/utils/windowsProcessTable');
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    default: {
      ...actual,
      execFile: childProcessMock.execFile,
      execFileSync: childProcessMock.execFileSync,
    },
    execFile: childProcessMock.execFile,
    execFileSync: childProcessMock.execFileSync,
  };
});

let windowsProcessTable: WindowsProcessTableModule;

describe('windowsProcessTable', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    windowsProcessTable = await import('../../../src/main/utils/windowsProcessTable');
  });

  it.each([
    [{ code: 7, signal: 'SIGTERM', killed: true, errno: -1 }, 'unknown'],
    [{ code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true }, 'true'],
    [{ killed: true }, 'unknown'],
    [{}, 'unknown'],
  ])('reports only available outcome metadata for %j', async (metadata, timedOut) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(137);
    const callbacks = captureExecFileCallbacks();
    const request = windowsProcessTable.listWindowsProcessTable(123, { bypassCache: true });
    callbacks[0](
      Object.assign(new Error('foreign command --private-data'), metadata),
      'foreign process table stdout',
      'access denied API_KEY="mock-secret" --token mock-token'
    );
    const error = await request.catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = String(error);
    expect(message).toContain('windows_process_enumeration: probe failed');
    expect(message).toContain('durationMs=37; timeoutMs=123');
    expect(message).toContain(`timedOut=${timedOut}`);
    for (const [key, value] of Object.entries(metadata))
      expect(message).toContain(`${key}=${value}`);
    expect(message).toContain('access denied');
    expect(message).not.toMatch(/foreign|mock-secret|mock-token|code=0/);
    clock.mockRestore();
  });

  it('keeps empty stderr and missing outcome unknown, including stderr-only rejection', async () => {
    for (const [error, stderr] of [
      [new Error('ignored'), ''],
      [null, 'warning'],
    ] as const) {
      const callbacks = captureExecFileCallbacks();
      const request = windowsProcessTable.listWindowsProcessTable();
      callbacks[0](error, 'private stdout', stderr);
      await expect(request).rejects.toThrow(`stderr=${JSON.stringify(stderr)}`);
      await expect(request).rejects.not.toThrow(/code=|signal=|killed=|private/);
    }
  });

  it('sanitizes before bounding stderr and leaves successful parse and sync behavior unchanged', async () => {
    const callbacks = captureExecFileCallbacks();
    const failed = windowsProcessTable.listWindowsProcessTable();
    callbacks[0](
      new Error('ignored'),
      '',
      '--password "' + 'private'.repeat(200) + '" end ' + 'x'.repeat(600)
    );
    const message = String(await failed.catch((error: Error) => error));
    expect(message).toContain('--password [redacted] end');
    expect(message).not.toContain('private');
    expect(message.length).toBeLessThan(750);
    const success = windowsProcessTable.listWindowsProcessTable();
    callbacks[1](null, 'malformed private stdout', '');
    await expect(success).resolves.toEqual([]);
    childProcessMock.execFileSync.mockReturnValue(makeProcessTableJson(5));
    expect(windowsProcessTable.listWindowsProcessTableSync()).toEqual([
      expect.objectContaining({ pid: 5 }),
    ]);
    expect(childProcessMock.execFileSync.mock.calls[0][2].timeout).toBe(4_000);
  });

  it('parses PowerShell process table JSON objects and arrays', () => {
    expect(
      windowsProcessTable.parseWindowsProcessTableJson(
        JSON.stringify([
          {
            ProcessId: 101,
            ParentProcessId: 1,
            CommandLine: 'node runtime --team-name demo --agent-id agent-a',
          },
          {
            ProcessId: '102',
            ParentProcessId: '101',
            CommandLine: 'opencode serve',
          },
          {
            ProcessId: 103,
            ParentProcessId: 1,
            CommandLine: null,
          },
        ])
      )
    ).toEqual([
      { pid: 101, ppid: 1, command: 'node runtime --team-name demo --agent-id agent-a' },
      { pid: 102, ppid: 101, command: 'opencode serve' },
    ]);

    expect(
      windowsProcessTable.parseWindowsProcessTableJson(
        JSON.stringify({
          ProcessId: 201,
          ParentProcessId: 1,
          CommandLine: 'claude --team-name demo --agent-id agent-b',
        })
      )
    ).toEqual([{ pid: 201, ppid: 1, command: 'claude --team-name demo --agent-id agent-b' }]);
  });

  it('bypasses both cached and in-flight process table snapshots for cleanup reads', async () => {
    const callbacks = captureExecFileCallbacks();

    const cachedRequest = windowsProcessTable.listWindowsProcessTable();
    const inFlightBypass = windowsProcessTable.listWindowsProcessTable(4_000, {
      bypassCache: true,
    });
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);

    callbacks[1]?.(null, makeProcessTableJson(301), '');
    await expect(inFlightBypass).resolves.toEqual([expect.objectContaining({ pid: 301 })]);
    const joinedCachedRequest = windowsProcessTable.listWindowsProcessTable();
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);

    callbacks[0]?.(null, makeProcessTableJson(300), '');
    await expect(cachedRequest).resolves.toEqual([expect.objectContaining({ pid: 300 })]);
    await expect(joinedCachedRequest).resolves.toEqual([expect.objectContaining({ pid: 300 })]);
    await expect(windowsProcessTable.listWindowsProcessTable()).resolves.toEqual([
      expect.objectContaining({ pid: 300 }),
    ]);

    const cachedBypass = windowsProcessTable.listWindowsProcessTable(4_000, {
      bypassCache: true,
    });
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(3);
    callbacks[2]?.(null, makeProcessTableJson(302), '');
    await expect(cachedBypass).resolves.toEqual([expect.objectContaining({ pid: 302 })]);
    await expect(windowsProcessTable.listWindowsProcessTable()).resolves.toEqual([
      expect.objectContaining({ pid: 300 }),
    ]);

    expect(childProcessMock.execFile).toHaveBeenCalledTimes(3);
  });

  it('keeps the shared request and cache intact when an independent bypass probe fails', async () => {
    const callbacks = captureExecFileCallbacks();

    const cachedRequest = windowsProcessTable.listWindowsProcessTable();
    const failedBypass = windowsProcessTable.listWindowsProcessTable(4_000, {
      bypassCache: true,
    });
    const failedBypassExpectation = expect(failedBypass).rejects.toThrow('probe failed');

    callbacks[1]?.(new Error('probe failed'), '', '');
    await failedBypassExpectation;

    const joinedCachedRequest = windowsProcessTable.listWindowsProcessTable();
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);

    callbacks[0]?.(null, makeProcessTableJson(303), '');
    await expect(cachedRequest).resolves.toEqual([expect.objectContaining({ pid: 303 })]);
    await expect(joinedCachedRequest).resolves.toEqual([expect.objectContaining({ pid: 303 })]);
    await expect(windowsProcessTable.listWindowsProcessTable()).resolves.toEqual([
      expect.objectContaining({ pid: 303 }),
    ]);
    expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);
  });
});

function captureExecFileCallbacks(): ExecCallback[] {
  const callbacks: ExecCallback[] = [];
  childProcessMock.execFile.mockImplementation(((
    _command: string,
    _args: readonly string[],
    _options: unknown,
    callback: ExecCallback
  ) => {
    callbacks.push(callback);
    return {} as never;
  }) as never);
  return callbacks;
}

function makeProcessTableJson(pid: number): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: 1,
    CommandLine: 'opencode.exe serve --hostname 127.0.0.1',
  });
}
