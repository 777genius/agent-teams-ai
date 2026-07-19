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
