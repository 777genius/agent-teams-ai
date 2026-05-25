// @vitest-environment node
import {
  createWindowsElevationStatusChecker,
  resetWindowsElevationStatusCacheForTests,
} from '@main/utils/windowsElevation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WindowsElevationCommandRunner } from '@main/utils/windowsElevation';

function createError(
  message: string,
  fields: { code?: string | number; killed?: boolean; signal?: string | null } = {}
): Error & { code?: string | number; killed?: boolean; signal?: string | null } {
  return Object.assign(new Error(message), fields);
}

const originalSystemRoot = process.env.SystemRoot;
const originalWindir = process.env.windir;
const originalWINDIR = process.env.WINDIR;

function restoreEnvValue(name: 'SystemRoot' | 'windir' | 'WINDIR', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('windowsElevation', () => {
  afterEach(() => {
    resetWindowsElevationStatusCacheForTests();
    restoreEnvValue('SystemRoot', originalSystemRoot);
    restoreEnvValue('windir', originalWindir);
    restoreEnvValue('WINDIR', originalWINDIR);
  });

  it('does not run the elevation command outside Windows', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>();

    const status = await createWindowsElevationStatusChecker({
      platform: 'darwin',
      runCommand,
    })();

    expect(runCommand).not.toHaveBeenCalled();
    expect(status).toEqual({
      platform: 'darwin',
      isWindows: false,
      isAdministrator: null,
      checkFailed: false,
      error: null,
    });
  });

  it('reports Administrator mode when fltmc succeeds', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValue({ error: null });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledWith('C:\\Windows\\System32\\fltmc.exe', {
      timeoutMs: 3_000,
    });
    expect(status.isAdministrator).toBe(true);
    expect(status.checkFailed).toBe(false);
  });

  it('reports non-elevated Windows when fltmc exits with an error', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Command failed', { code: 1 }),
      stderr: 'Access is denied.',
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isWindows).toBe(true);
    expect(status.isAdministrator).toBe(false);
    expect(status.checkFailed).toBe(false);
    expect(status.error).toBe('Access is denied.');
  });

  it('reports non-elevated Windows when fltmc returns an access-denied message', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Command failed', { code: 'EPERM' }),
      stderr: 'The requested operation requires elevation.',
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBe(false);
    expect(status.checkFailed).toBe(false);
  });

  it('reports non-elevated Windows when stderr is a Buffer', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Command failed', { code: 'EPERM' }),
      stderr: Buffer.from('Access is denied.', 'utf8'),
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBe(false);
    expect(status.error).toBe('Access is denied.');
  });

  it('uses the error message when stderr is empty', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('operation not permitted', { code: 'EPERM' }),
      stderr: '',
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBe(false);
    expect(status.error).toBe('operation not permitted');
  });

  it('reports non-elevated Windows when fltmc returns Windows access-denied code 5', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Command failed', { code: 5 }),
      stderr: '',
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBe(false);
    expect(status.checkFailed).toBe(false);
  });

  it('passes a custom timeout to the Windows probe command', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValue({ error: null });

    await createWindowsElevationStatusChecker({
      platform: 'win32',
      timeoutMs: 750,
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledWith('C:\\Windows\\System32\\fltmc.exe', {
      timeoutMs: 750,
    });
  });

  it('reports an unknown status when fltmc fails for an unrelated reason', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Unexpected fltmc failure', { code: 2 }),
      stderr: 'The system cannot find the file specified.',
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBeNull();
    expect(status.checkFailed).toBe(true);
    expect(status.error).toBe('The system cannot find the file specified.');
  });

  it('caps long probe error text before returning it to the renderer', async () => {
    const longError = 'x'.repeat(600);
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Unexpected fltmc failure', { code: 2 }),
      stderr: longError,
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBeNull();
    expect(status.error).toHaveLength(500);
  });

  it('does not treat code 1 as non-elevated when the probe executable is unavailable', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Command failed', { code: 1 }),
      stderr: 'The system cannot find the file specified.',
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBeNull();
    expect(status.checkFailed).toBe(true);
    expect(status.error).toBe('The system cannot find the file specified.');
  });

  it('does not treat code 1 as non-elevated when Windows cannot recognize the probe command', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Command failed', { code: 1 }),
      stderr: "'fltmc.exe' is not recognized as an internal or external command.",
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBeNull();
    expect(status.checkFailed).toBe(true);
  });

  it('reports an unknown status when the Windows probe command is missing', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('spawn fltmc.exe ENOENT', { code: 'ENOENT' }),
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBeNull();
    expect(status.checkFailed).toBe(true);
    expect(status.error).toBe('Windows elevation probe command was not found.');
  });

  it('continues to the next path when the probe command throws ENOENT', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockRejectedValueOnce(createError('spawn fltmc.exe ENOENT', { code: 'ENOENT' }))
      .mockResolvedValueOnce({ error: null });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      arch: 'ia32',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(status.isAdministrator).toBe(true);
  });

  it('reports an unknown status when the Windows probe times out', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Command timed out', { code: 'ETIMEDOUT', killed: true }),
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBeNull();
    expect(status.checkFailed).toBe(true);
    expect(status.error).toContain('Command timed out');
  });

  it('does not try the System32 fallback after a Sysnative timeout', async () => {
    const runCommand = vi.fn<WindowsElevationCommandRunner>().mockResolvedValue({
      error: createError('Command timed out', { code: 'ETIMEDOUT', killed: true }),
    });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      arch: 'ia32',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(status.isAdministrator).toBeNull();
    expect(status.checkFailed).toBe(true);
  });

  it('tries the Sysnative fltmc path first for 32-bit Windows processes', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValueOnce({
        error: createError('spawn fltmc.exe ENOENT', { code: 'ENOENT' }),
      })
      .mockResolvedValueOnce({ error: null });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      arch: 'ia32',
      systemRoot: 'C:\\Windows',
      runCommand,
    })();

    expect(runCommand).toHaveBeenNthCalledWith(1, 'C:\\Windows\\Sysnative\\fltmc.exe', {
      timeoutMs: 3_000,
    });
    expect(runCommand).toHaveBeenNthCalledWith(2, 'C:\\Windows\\System32\\fltmc.exe', {
      timeoutMs: 3_000,
    });
    expect(status.isAdministrator).toBe(true);
  });

  it('uses only System32 for non-32-bit Windows processes', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValue({ error: null });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      arch: 'arm64',
      systemRoot: 'C:\\Windows',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('C:\\Windows\\System32\\fltmc.exe', {
      timeoutMs: 3_000,
    });
    expect(status.isAdministrator).toBe(true);
  });

  it('continues from missing Sysnative to a non-elevated System32 result', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValueOnce({
        error: createError('spawn fltmc.exe ENOENT', { code: 'ENOENT' }),
      })
      .mockResolvedValueOnce({
        error: createError('Command failed', { code: 5 }),
        stderr: '',
      });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      arch: 'ia32',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(status.isAdministrator).toBe(false);
  });

  it('falls back to the default Windows root when SystemRoot is empty', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValue({ error: null });

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      systemRoot: '',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledWith('C:\\Windows\\System32\\fltmc.exe', {
      timeoutMs: 3_000,
    });
    expect(status.isAdministrator).toBe(true);
  });

  it('normalizes quoted Windows root values', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValue({ error: null });

    await createWindowsElevationStatusChecker({
      platform: 'win32',
      systemRoot: '  "D:\\Windows"  ',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledWith('D:\\Windows\\System32\\fltmc.exe', {
      timeoutMs: 3_000,
    });
  });

  it('falls back to windir when SystemRoot is unavailable', async () => {
    delete process.env.SystemRoot;
    process.env.windir = 'E:\\WinDir';
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValue({ error: null });

    await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledWith('E:\\WinDir\\System32\\fltmc.exe', {
      timeoutMs: 3_000,
    });
  });

  it('falls back to uppercase WINDIR when SystemRoot and windir are unavailable', async () => {
    delete process.env.SystemRoot;
    delete process.env.windir;
    process.env.WINDIR = 'F:\\Windows';
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValue({ error: null });

    await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledWith('F:\\Windows\\System32\\fltmc.exe', {
      timeoutMs: 3_000,
    });
  });

  it('falls back to the default Windows root for relative SystemRoot values', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockResolvedValue({ error: null });

    await createWindowsElevationStatusChecker({
      platform: 'win32',
      systemRoot: 'Windows',
      runCommand,
    })();

    expect(runCommand).toHaveBeenCalledWith('C:\\Windows\\System32\\fltmc.exe', {
      timeoutMs: 3_000,
    });
  });

  it('reports an unknown status when the Windows probe throws before returning a result', async () => {
    const runCommand = vi
      .fn<WindowsElevationCommandRunner>()
      .mockRejectedValue(new Error('spawn failed'));

    const status = await createWindowsElevationStatusChecker({
      platform: 'win32',
      runCommand,
    })();

    expect(status.isAdministrator).toBeNull();
    expect(status.checkFailed).toBe(true);
    expect(status.error).toBe('spawn failed');
  });
});
