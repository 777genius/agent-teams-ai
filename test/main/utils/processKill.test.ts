// @vitest-environment node
import { killProcessByPidAndWait } from '@main/utils/processKill';
import * as childProcess from 'child_process';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

describe('processKill', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects awaited Windows cleanup when taskkill is denied and the pid remains alive', async () => {
    const execFileMock = childProcess.execFile as unknown as Mock;
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null) => void
      ) => {
        callback(new Error('Access is denied'));
        return {};
      }
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) {
        return true;
      }
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    await expect(
      killProcessByPidAndWait(71633, {
        platform: 'win32',
        timeoutMs: 0,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow(
      'Process 71633 remained alive after cleanup: taskkill failed (Access is denied); direct termination failed (operation not permitted)'
    );
    expect(killSpy).toHaveBeenCalledWith(71633, 'SIGTERM');
  });

  it('accepts taskkill failure when the target pid already exited', async () => {
    const execFileMock = childProcess.execFile as unknown as Mock;
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null) => void
      ) => {
        callback(new Error('process not found'));
        return {};
      }
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockReturnValueOnce(true)
      .mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });

    await expect(
      killProcessByPidAndWait(71634, {
        platform: 'win32',
        timeoutMs: 0,
        pollIntervalMs: 0,
      })
    ).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalledWith(71634, 'SIGTERM');
  });

  it('refuses direct termination when the pid identity changed after taskkill', async () => {
    const execFileMock = childProcess.execFile as unknown as Mock;
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null) => void
      ) => {
        callback(new Error('Access is denied'));
        return {};
      }
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error('must not signal a reused pid');
    });

    await expect(
      killProcessByPidAndWait(71635, {
        platform: 'win32',
        confirmTargetIdentity: () => false,
      })
    ).rejects.toThrow('identity changed during cleanup');
    expect(killSpy).not.toHaveBeenCalledWith(71635, 'SIGTERM');
  });
});
