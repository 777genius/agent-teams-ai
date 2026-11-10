// @vitest-environment node
import fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectExecCliErrorText,
  execCliWithOpenCodeRecovery,
  tryRecoverOpenCodeNodeModulesJunctionFromError,
} from '@main/utils/openCodeNodeModulesJunction';

const SYMLINK_EPERM_MESSAGE = [
  'EPERM: operation not permitted, symlink',
  "'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules'",
  '->',
  "'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules'",
].join(' ');

describe('execCliWithOpenCodeRecovery', () => {
  it('repairs the junction and retries once when the first run fails with the profile symlink EPERM', async () => {
    const firstError = Object.assign(new Error('Command failed'), {
      stderr: SYMLINK_EPERM_MESSAGE,
    });
    const exec = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce({ stdout: '{"ok":true}', stderr: '' });
    const recover = vi.fn(() => true);

    const result = await execCliWithOpenCodeRecovery(
      '/usr/local/bin/claude-multimodel',
      ['model', 'list', '--json', '--provider', 'opencode'],
      { timeout: 1_000 },
      { exec, recover }
    );

    expect(result).toEqual({ stdout: '{"ok":true}', stderr: '' });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(
      2,
      '/usr/local/bin/claude-multimodel',
      ['model', 'list', '--json', '--provider', 'opencode'],
      { timeout: 1_000 }
    );
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
    expect(recover).toHaveBeenCalledWith(expect.stringContaining('profiles\\abc123'));
  });

  it('rethrows the original error when junction recovery is not possible', async () => {
    const firstError = Object.assign(new Error('Command failed'), {
      stderr: SYMLINK_EPERM_MESSAGE,
    });
    const exec = vi.fn().mockRejectedValue(firstError);
    const recover = vi.fn(() => false);

    await expect(
      execCliWithOpenCodeRecovery('/bin/cli', ['runtime', 'status'], {}, { exec, recover })
    ).rejects.toBe(firstError);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('retries at most once when the EPERM persists after the junction repair', async () => {
    const firstError = Object.assign(new Error('Command failed'), {
      stderr: SYMLINK_EPERM_MESSAGE,
    });
    const secondError = Object.assign(new Error('Command failed again'), {
      stderr: SYMLINK_EPERM_MESSAGE,
    });
    const exec = vi.fn().mockRejectedValueOnce(firstError).mockRejectedValueOnce(secondError);
    const recover = vi.fn(() => true);

    await expect(
      execCliWithOpenCodeRecovery('/bin/cli', ['runtime', 'status'], {}, { exec, recover })
    ).rejects.toBe(secondError);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('leaves non-matching failures to the caller without any recovery attempt', async () => {
    const error = Object.assign(new Error('model list failed'), { stderr: 'boom' });
    const exec = vi.fn().mockRejectedValue(error);

    await expect(
      execCliWithOpenCodeRecovery('/bin/cli', ['model', 'list'], {}, { exec })
    ).rejects.toBe(error);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('tryRecoverOpenCodeNodeModulesJunctionFromError', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it('returns false on non-Windows platforms even for matching errors', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(tryRecoverOpenCodeNodeModulesJunctionFromError(SYMLINK_EPERM_MESSAGE)).toBe(false);
  });

  it('returns false for error text without the symlink EPERM signature', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(
      tryRecoverOpenCodeNodeModulesJunctionFromError('ENOENT: no such file or directory, open')
    ).toBe(false);
  });

  it('returns false when the error text has no profile id', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(
      tryRecoverOpenCodeNodeModulesJunctionFromError(
        "EPERM: operation not permitted, symlink 'opencode' -> 'node_modules'"
      )
    ).toBe(false);
  });

  it('creates the profile junction and returns true for a matching Windows error', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const originalEnv = process.env.LOCALAPPDATA;
    // A different local base proves the validated error-derived paths win.
    process.env.LOCALAPPDATA = 'C:\\fallback\\local';
    try {
      const expectedSource =
        'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Cache\\opencode\\shared-cache\\config-node_modules';
      const expectedTarget =
        'C:\\Users\\test\\AppData\\Local\\claude-multimodel-nodejs\\Data\\opencode\\profiles\\abc123\\config\\opencode\\node_modules';
      let statCallCount = 0;
      const statSyncSpy = vi
        .spyOn(fs, 'statSync')
        .mockImplementation((..._args: Parameters<typeof fs.statSync>) => {
          statCallCount += 1;
          // First stat inspects the missing profile target, second the shared cache.
          return (statCallCount === 1 ? undefined : ({} as fs.Stats)) as fs.Stats;
        });
      const mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const symlinkSyncSpy = vi.spyOn(fs, 'symlinkSync').mockReturnValue(undefined);

      expect(tryRecoverOpenCodeNodeModulesJunctionFromError(SYMLINK_EPERM_MESSAGE)).toBe(true);
      expect(symlinkSyncSpy).toHaveBeenCalledWith(expectedSource, expectedTarget, 'junction');
      expect(statSyncSpy).toHaveBeenCalled();
      expect(mkdirSyncSpy).toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalEnv;
      }
    }
  });
});

describe('collectExecCliErrorText', () => {
  it('combines the error message with stderr and stdout payloads', () => {
    const error = Object.assign(new Error('Command failed'), {
      stderr: SYMLINK_EPERM_MESSAGE,
      stdout: 'partial output',
    });
    const text = collectExecCliErrorText(error);
    expect(text).toContain('Command failed');
    expect(text).toContain('EPERM: operation not permitted, symlink');
    expect(text).toContain('partial output');
  });

  it('decodes Buffer stderr payloads', () => {
    const error = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from(SYMLINK_EPERM_MESSAGE, 'utf8'),
    });
    expect(collectExecCliErrorText(error)).toContain('symlink');
  });

  it('stringifies non-Error failures', () => {
    expect(collectExecCliErrorText('plain failure')).toBe('plain failure');
  });
});
