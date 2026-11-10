// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: mocks.execFile,
  };
});

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void;

function createError(
  message: string,
  fields: { code?: string | number; killed?: boolean; signal?: string | null } = {}
): Error & { code?: string | number; killed?: boolean; signal?: string | null } {
  return Object.assign(new Error(message), fields);
}

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

function setArch(value: string): void {
  Object.defineProperty(process, 'arch', {
    value,
    configurable: true,
  });
}

const originalPlatform = process.platform;
const originalArch = process.arch;
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

async function importRuntime() {
  return import('@main/utils/windowsElevation');
}

describe('windowsElevation runtime integration', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.execFile.mockReset();
    setPlatform(originalPlatform);
    setArch(originalArch);
    restoreEnvValue('SystemRoot', originalSystemRoot);
    restoreEnvValue('windir', originalWindir);
    restoreEnvValue('WINDIR', originalWINDIR);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    setArch(originalArch);
    restoreEnvValue('SystemRoot', originalSystemRoot);
    restoreEnvValue('windir', originalWindir);
    restoreEnvValue('WINDIR', originalWINDIR);
    vi.restoreAllMocks();
  });

  it('does not invoke execFile when the process platform is not Windows', async () => {
    setPlatform('linux');
    const { getWindowsElevationStatus } = await importRuntime();

    const status = await getWindowsElevationStatus();

    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(status).toEqual({
      platform: 'linux',
      isWindows: false,
      isAdministrator: null,
      checkFailed: false,
      error: null,
    });
  });

  it('runs fltmc with hidden-window timeout options on Windows', async () => {
    setPlatform('win32');
    setArch('x64');
    process.env.SystemRoot = 'C:\\Windows';
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, '', '');
      }
    );
    const { getWindowsElevationStatus } = await importRuntime();

    const status = await getWindowsElevationStatus();

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\fltmc.exe',
      [],
      { timeout: 3_000, windowsHide: true },
      expect.any(Function)
    );
    expect(status.isAdministrator).toBe(true);
  });

  it('coalesces concurrent status requests into one Windows subprocess', async () => {
    setPlatform('win32');
    setArch('x64');
    const captured: { callback?: ExecFileCallback } = {};
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, nextCallback: ExecFileCallback) => {
        captured.callback = nextCallback;
      }
    );
    const { getWindowsElevationStatus } = await importRuntime();

    const first = getWindowsElevationStatus();
    const second = getWindowsElevationStatus();

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(captured.callback).toBeTypeOf('function');
    captured.callback?.(null, '', '');
    await expect(first).resolves.toMatchObject({ isAdministrator: true });
    await expect(second).resolves.toMatchObject({ isAdministrator: true });
  });

  it('reuses the cached result after the first Windows probe completes', async () => {
    setPlatform('win32');
    setArch('x64');
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(createError('Command failed', { code: 5 }), '', '');
      }
    );
    const { getWindowsElevationStatus } = await importRuntime();

    const first = await getWindowsElevationStatus();
    const second = await getWindowsElevationStatus();

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(second.isAdministrator).toBe(false);
  });

  it('runs a new probe after the cache is reset for tests', async () => {
    setPlatform('win32');
    setArch('x64');
    mocks.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, '', '');
      }
    );
    const { getWindowsElevationStatus, resetWindowsElevationStatusCacheForTests } =
      await importRuntime();

    await getWindowsElevationStatus();
    resetWindowsElevationStatusCacheForTests();
    await getWindowsElevationStatus();

    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });
});
