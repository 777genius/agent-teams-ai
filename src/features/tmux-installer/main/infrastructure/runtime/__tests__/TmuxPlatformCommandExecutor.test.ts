// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
  };
});

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

import { TmuxPlatformCommandExecutor } from '../TmuxPlatformCommandExecutor';

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: true,
  });
}

const originalPlatform = process.platform;
const originalWindir = process.env.WINDIR;

describe('TmuxPlatformCommandExecutor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(fs.promises, 'readdir').mockRejectedValue(new Error('ENOENT'));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalWindir === undefined) {
      delete process.env.WINDIR;
    } else {
      process.env.WINDIR = originalWindir;
    }
  });

  it('falls back to plain wsl.exe for sync cleanup when WINDIR is missing', () => {
    setPlatform('win32');
    delete process.env.WINDIR;

    const execFileSyncMock = childProcess.execFileSync as unknown as Mock;
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === 'wsl.exe') {
        return Buffer.from('');
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const executor = new TmuxPlatformCommandExecutor(
      {
        getPersistedPreferredDistroSync: () => null,
      } as never,
      {} as never
    );

    expect(() => executor.killPaneSync('%1')).not.toThrow();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-e', 'tmux', 'kill-pane', '-t', '%1'],
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true,
      })
    );
  });

  it('lists pane pids for the requested pane ids only', async () => {
    const executor = new TmuxPlatformCommandExecutor(
      {
        getPersistedPreferredDistroSync: () => null,
      } as never,
      {} as never
    );
    const execTmux = vi.spyOn(executor, 'execTmux').mockResolvedValue({
      exitCode: 0,
      stdout:
        '%1\t111\tzsh\t/tmp\tteam\tmain\n%2\t222\tnode\t/project\tteam\tworker\n%3\tnot-a-pid\tzsh\t/tmp\tteam\tmain\n',
      stderr: '',
    });

    await expect(executor.listPanePids(['%2', '%3', '%2'])).resolves.toEqual(
      new Map([['%2', 222]])
    );
    expect(execTmux).toHaveBeenCalledWith(
      [
        'list-panes',
        '-a',
        '-F',
        '#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}\t#{window_name}',
      ],
      3_000,
      undefined
    );
  });

  it('lists runtime processes inside WSL on Windows instead of using host ps', async () => {
    setPlatform('win32');
    const execInPreferredDistro = vi.fn(async () => ({
      exitCode: 0,
      stdout: '  42   1  3.5  1024 opencode runtime --team-name demo\n',
      stderr: '',
    }));
    const executor = new TmuxPlatformCommandExecutor(
      {
        execInPreferredDistro,
        getPersistedPreferredDistroSync: () => 'Ubuntu',
      } as never,
      {} as never
    );

    await expect(executor.listRuntimeProcesses()).resolves.toEqual([
      {
        pid: 42,
        ppid: 1,
        command: 'opencode runtime --team-name demo',
        cpuPercent: 3.5,
        rssBytes: 1024 * 1024,
      },
    ]);
    expect(execInPreferredDistro).toHaveBeenCalledWith([
      'ps',
      '-ax',
      '-o',
      'pid=,ppid=,pcpu=,rss=,command=',
    ]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});
