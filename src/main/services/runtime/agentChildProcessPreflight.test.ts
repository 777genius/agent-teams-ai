// @vitest-environment node
import {
  applyAgentChildProcessWritableEnv,
  prepareAgentChildProcessWritableEnv,
} from '@main/services/runtime/agentChildProcessPreflight';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('agent child-process writable env', () => {
  let tmpRoot: string;

  beforeEach(() => {
    setPlatform('win32');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-child-env-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not mutate env on non-Windows platforms', async () => {
    setPlatform('darwin');
    const env: NodeJS.ProcessEnv = {
      TEMP: path.join(tmpRoot, 'existing-temp'),
    };

    const result = await prepareAgentChildProcessWritableEnv(env, { home: tmpRoot });

    expect(result).toEqual({ applied: false });
    expect(env).toEqual({
      TEMP: path.join(tmpRoot, 'existing-temp'),
    });
  });

  it('prepares stable writable cache and temp env for Windows agents', async () => {
    const home = path.join(tmpRoot, 'home');
    const env: NodeJS.ProcessEnv = {
      COMSPEC: 'cmd.exe',
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    };

    const result = await prepareAgentChildProcessWritableEnv(env, { home });

    const expectedBase = path.join(home, 'AppData', 'Local', 'AgentStudio', 'runner-cache');
    expect(result).toEqual({ applied: true, cacheBase: expectedBase });
    expect(env.TEMP).toBe(path.join(expectedBase, 'tmp'));
    expect(env.TMP).toBe(path.join(expectedBase, 'tmp'));
    expect(env.TMPDIR).toBe(path.join(expectedBase, 'tmp'));
    expect(env.npm_config_cache).toBe(path.join(expectedBase, 'npm-cache'));
    expect(env.NPM_CONFIG_CACHE).toBe(path.join(expectedBase, 'npm-cache'));
    expect(env.GRADLE_USER_HOME).toBe(path.join(expectedBase, 'gradle-home'));
    expect(env.ANDROID_USER_HOME).toBe(path.join(expectedBase, 'android-home'));
    expect(env.ANDROID_SDK_HOME).toBe(path.join(expectedBase, 'android-home'));
    expect(env.npm_config_script_shell).toBe('cmd.exe');
    expect(env.AGENT_STUDIO_NPM_CMD).toBe('npm.cmd');
    expect(env.AGENT_STUDIO_NPX_CMD).toBe('npx.cmd');
    expect(env.GRADLE_OPTS).toContain('-Djava.io.tmpdir=');
    expect(env.JAVA_TOOL_OPTIONS).toContain('-Djava.io.tmpdir=');

    await expect(fs.promises.access(path.join(expectedBase, 'tmp'))).resolves.toBeUndefined();
    await expect(fs.promises.access(path.join(expectedBase, 'npm-cache'))).resolves.toBeUndefined();
    await expect(
      fs.promises.access(path.join(expectedBase, 'gradle-home'))
    ).resolves.toBeUndefined();
    await expect(
      fs.promises.access(path.join(expectedBase, 'android-home'))
    ).resolves.toBeUndefined();

    for (const dirName of ['tmp', 'npm-cache', 'gradle-home', 'android-home']) {
      const entries = await fs.promises.readdir(path.join(expectedBase, dirName));
      const probeEntries = entries.filter((entry) =>
        entry.startsWith('.agent-studio-write-probe-')
      );
      expect(probeEntries).toEqual([]);
    }
  });

  it('fails open and leaves existing env untouched when cache dirs cannot be created', async () => {
    const home = path.join(tmpRoot, 'home');
    const originalTemp = path.join(tmpRoot, 'existing-temp');
    const env: NodeJS.ProcessEnv = {
      COMSPEC: 'cmd.exe',
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: originalTemp,
      TMP: originalTemp,
    };
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(new Error('EACCES'));

    const result = await prepareAgentChildProcessWritableEnv(env, { home });

    expect(result.applied).toBe(false);
    expect(result.cacheBase).toBe(
      path.join(home, 'AppData', 'Local', 'AgentStudio', 'runner-cache')
    );
    expect(result.warning).toContain('keeping existing temp/cache env');
    expect(env).toEqual({
      COMSPEC: 'cmd.exe',
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: originalTemp,
      TMP: originalTemp,
    });
  });

  it('fails open and leaves existing env untouched when cache dirs are not writable', async () => {
    const home = path.join(tmpRoot, 'home');
    const originalTemp = path.join(tmpRoot, 'existing-temp');
    const env: NodeJS.ProcessEnv = {
      COMSPEC: 'cmd.exe',
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: originalTemp,
      TMP: originalTemp,
    };
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('EPERM'));

    const result = await prepareAgentChildProcessWritableEnv(env, { home });

    expect(result.applied).toBe(false);
    expect(result.cacheBase).toBe(
      path.join(home, 'AppData', 'Local', 'AgentStudio', 'runner-cache')
    );
    expect(result.warning).toContain('failed writable check');
    expect(result.warning).toContain('EPERM');
    expect(env).toEqual({
      COMSPEC: 'cmd.exe',
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: originalTemp,
      TMP: originalTemp,
    });
  });

  it('keeps the synchronous env applicator available for prepared directories', () => {
    const home = path.join(tmpRoot, 'home');
    const env: NodeJS.ProcessEnv = {
      COMSPEC: 'cmd.exe',
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    };

    applyAgentChildProcessWritableEnv(env, { home });

    const expectedBase = path.join(home, 'AppData', 'Local', 'AgentStudio', 'runner-cache');
    expect(env.TEMP).toBe(path.join(expectedBase, 'tmp'));
    expect(env.TMP).toBe(path.join(expectedBase, 'tmp'));
    expect(env.TMPDIR).toBe(path.join(expectedBase, 'tmp'));
  });
});
