// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import * as childProcess from 'child_process';
import {
  applyAgentChildProcessWritableEnv,
  assertAgentChildProcessPreflight,
} from './agentChildProcessPreflight';

const originalPlatform = process.platform;
const spawnSyncMock = vi.mocked(childProcess.spawnSync);

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: true,
  });
}

function successfulSpawn(stdout = '1.0.0\n'): childProcess.SpawnSyncReturns<string> {
  return {
    output: [],
    pid: 123,
    signal: null,
    status: 0,
    stderr: '',
    stdout,
  };
}

describe('agent child-process preflight', () => {
  let tmpRoot: string;

  beforeEach(() => {
    setPlatform('win32');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-child-preflight-'));
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue(successfulSpawn());
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('injects stable writable cache and temp env for Windows agents', () => {
    const home = path.join(tmpRoot, 'home');
    const env: NodeJS.ProcessEnv = {
      COMSPEC: 'cmd.exe',
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    };

    applyAgentChildProcessWritableEnv(env, { home });

    const expectedBase = path.join(home, 'AppData', 'Local', 'AgentStudio', 'runner-cache');
    expect(env.TEMP).toBe(path.join(expectedBase, 'tmp'));
    expect(env.TMP).toBe(path.join(expectedBase, 'tmp'));
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
  });

  it('checks writable roots and .cmd shims before the agent starts', async () => {
    const env: NodeJS.ProcessEnv = {
      COMSPEC: 'cmd.exe',
      TEMP: path.join(tmpRoot, 'tmp'),
      TMP: path.join(tmpRoot, 'tmp'),
      npm_config_cache: path.join(tmpRoot, 'npm-cache'),
      GRADLE_USER_HOME: path.join(tmpRoot, 'gradle-home'),
      ANDROID_USER_HOME: path.join(tmpRoot, 'android-home'),
      ANDROID_SDK_HOME: path.join(tmpRoot, 'android-home'),
    };
    const cwd = path.join(tmpRoot, 'workspace');

    await assertAgentChildProcessPreflight({ cwd, env, timeoutMs: 1_000 });

    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      'node.exe',
      expect.any(Array),
      expect.objectContaining({ cwd, env, timeout: 1_000, windowsHide: true })
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      'cmd.exe',
      ['/d', '/s', '/c', 'npm.cmd --version'],
      expect.objectContaining({ cwd, env, timeout: 1_000, windowsHide: true })
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      3,
      'cmd.exe',
      ['/d', '/s', '/c', 'npx.cmd --version'],
      expect.objectContaining({ cwd, env, timeout: 1_000, windowsHide: true })
    );
  });

  it('fails with a runner-level error when child process spawn is blocked', async () => {
    const env: NodeJS.ProcessEnv = {
      COMSPEC: 'cmd.exe',
      TEMP: path.join(tmpRoot, 'tmp'),
      npm_config_cache: path.join(tmpRoot, 'npm-cache'),
      GRADLE_USER_HOME: path.join(tmpRoot, 'gradle-home'),
      ANDROID_USER_HOME: path.join(tmpRoot, 'android-home'),
      ANDROID_SDK_HOME: path.join(tmpRoot, 'android-home'),
    };
    spawnSyncMock
      .mockReturnValueOnce({
        ...successfulSpawn(''),
        error: new Error('spawnSync node.exe EPERM'),
        status: null,
      })
      .mockReturnValue(successfulSpawn());

    await expect(
      assertAgentChildProcessPreflight({
        cwd: path.join(tmpRoot, 'workspace-failure'),
        env,
        timeoutMs: 1_000,
      })
    ).rejects.toThrow(/Agent child-process preflight failed/);
  });
});
