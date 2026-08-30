import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureWindowsSpawnBaseDirEnv,
  withCliProcessDefaults,
} from '@main/utils/cliProcessDefaults';

describe('ensureWindowsSpawnBaseDirEnv', () => {
  it('leaves the env untouched on non-Windows platforms', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const result = ensureWindowsSpawnBaseDirEnv(env, {
      platform: 'linux',
      processEnv: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    });

    expect(result).toBe(env);
    expect(result).toEqual({ PATH: '/usr/bin' });
  });

  it('fills missing base dirs from the parent process env on win32', () => {
    const env: NodeJS.ProcessEnv = {};

    ensureWindowsSpawnBaseDirEnv(env, {
      platform: 'win32',
      processEnv: {
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
        APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
        TEMP: 'C:\\Users\\test\\AppData\\Local\\Temp',
      },
    });

    expect(env.LOCALAPPDATA).toBe('C:\\Users\\test\\AppData\\Local');
    expect(env.APPDATA).toBe('C:\\Users\\test\\AppData\\Roaming');
    expect(env.TEMP).toBe('C:\\Users\\test\\AppData\\Local\\Temp');
    expect(env.TMP).toBe('C:\\Users\\test\\AppData\\Local\\Temp');
    // Pinned unconditionally: descendants outside our control can blank
    // LOCALAPPDATA for their own children, so the inherited override is the
    // only guarantee the cache never lands in the workspace cwd.
    expect(env.PSModuleAnalysisCachePath).toBe(
      'C:\\Users\\test\\AppData\\Local\\Temp\\PSModuleAnalysisCache'
    );
  });

  it('replaces empty or whitespace-only values that PowerShell would resolve cwd-relative', () => {
    const env: NodeJS.ProcessEnv = { LOCALAPPDATA: '', APPDATA: '   ' };

    ensureWindowsSpawnBaseDirEnv(env, {
      platform: 'win32',
      processEnv: {
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
        APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
        TEMP: 'C:\\Temp',
      },
    });

    expect(env.LOCALAPPDATA).toBe('C:\\Users\\test\\AppData\\Local');
    expect(env.APPDATA).toBe('C:\\Users\\test\\AppData\\Roaming');
  });

  it('derives base dirs from USERPROFILE when neither env carries them', () => {
    const env: NodeJS.ProcessEnv = {};

    ensureWindowsSpawnBaseDirEnv(env, {
      platform: 'win32',
      processEnv: { USERPROFILE: 'C:\\Users\\test' },
    });

    expect(env.LOCALAPPDATA).toBe('C:\\Users\\test\\AppData\\Local');
    expect(env.APPDATA).toBe('C:\\Users\\test\\AppData\\Roaming');
    expect(env.TEMP).toBe('C:\\Users\\test\\AppData\\Local\\Temp');
    expect(env.TMP).toBe('C:\\Users\\test\\AppData\\Local\\Temp');
  });

  it('never overrides existing non-empty values, including deliberate TEMP redirects', () => {
    const env: NodeJS.ProcessEnv = {
      LOCALAPPDATA: 'D:\\custom\\local',
      TEMP: 'D:\\runner-cache\\tmp',
      TMP: 'D:\\runner-cache\\tmp',
    };

    ensureWindowsSpawnBaseDirEnv(env, {
      platform: 'win32',
      processEnv: {
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
        TEMP: 'C:\\Users\\test\\AppData\\Local\\Temp',
      },
    });

    expect(env.LOCALAPPDATA).toBe('D:\\custom\\local');
    expect(env.TEMP).toBe('D:\\runner-cache\\tmp');
    expect(env.TMP).toBe('D:\\runner-cache\\tmp');
  });

  it('writes through differently-cased existing keys instead of duplicating them', () => {
    const env: NodeJS.ProcessEnv = { LocalAppData: '' };

    ensureWindowsSpawnBaseDirEnv(env, {
      platform: 'win32',
      processEnv: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    });

    expect(env.LocalAppData).toBe('C:\\Users\\test\\AppData\\Local');
    expect(Object.keys(env)).not.toContain('LOCALAPPDATA');
  });

  it('fills TEMP from an existing TMP value', () => {
    const env: NodeJS.ProcessEnv = { TMP: 'C:\\alt-tmp' };

    ensureWindowsSpawnBaseDirEnv(env, { platform: 'win32', processEnv: {} });

    expect(env.TEMP).toBe('C:\\alt-tmp');
    expect(env.TMP).toBe('C:\\alt-tmp');
  });

  it('pins PSModuleAnalysisCachePath to the temp dir when no user profile is resolvable', () => {
    const env: NodeJS.ProcessEnv = {};

    ensureWindowsSpawnBaseDirEnv(env, {
      platform: 'win32',
      processEnv: {},
      homedir: () => {
        throw new Error('no passwd entry');
      },
      tmpdir: () => 'C:\\Windows\\Temp',
    });

    expect('LOCALAPPDATA' in env).toBe(false);
    expect('APPDATA' in env).toBe(false);
    expect(env.TEMP).toBe('C:\\Windows\\Temp');
    expect(env.TMP).toBe('C:\\Windows\\Temp');
    expect(env.PSModuleAnalysisCachePath).toBe('C:\\Windows\\Temp\\PSModuleAnalysisCache');
  });
});

describe('withCliProcessDefaults', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('injects CLI env defaults while preserving caller env', () => {
    const callerEnv: NodeJS.ProcessEnv = { FOO: 'bar' };
    const options = withCliProcessDefaults({ env: callerEnv });

    expect(options.windowsHide).toBe(true);
    expect(options.env).toMatchObject({ FOO: 'bar', CLAUDE_HOOK_JUDGE_MODE: 'true' });
  });

  it('guarantees Windows per-user base dirs for every spawned CLI env', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const callerEnv: NodeJS.ProcessEnv = { FOO: 'bar' };
    const options = withCliProcessDefaults({ env: callerEnv });

    // Values come from the real process env or the real home dir; the
    // invariant under test is only that none of them is missing or empty.
    expect(options.env?.LOCALAPPDATA?.trim()).toBeTruthy();
    expect(options.env?.APPDATA?.trim()).toBeTruthy();
    expect(options.env?.TEMP?.trim()).toBeTruthy();
    expect(options.env?.TMP?.trim()).toBeTruthy();
    expect(options.detached).toBe(false);
  });
});
