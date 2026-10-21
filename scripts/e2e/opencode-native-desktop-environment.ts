import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { protectWindowsTestDirectory } from './opencode-native-test-auth';

/** Shared TEST environment for source preflight and packaged desktop. */
export async function prepareNativeDesktopEnvironment() {
  // Match the live proof wrapper's short Darwin root policy for nested sockets.
  const parent = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const root = await realpath(await mkdtemp(path.join(parent, 'TEST-oc-')));
  const projectPath = path.join(root, 'TEST-project');
  const teamName = `test-opencode-${randomUUID()}`;
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'DISPLAY',
    'XAUTHORITY',
    'LANG',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const directories = {
    HOME: 'home',
    USERPROFILE: 'home',
    APPDATA: 'app-data',
    LOCALAPPDATA: 'local-data',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    XDG_RUNTIME_DIR: 'run',
    TMPDIR: 'tmp',
    TMP: 'tmp',
    TEMP: 'tmp',
    CLAUDE_CONFIG_DIR: 'claude-config',
    CLAUDE_MULTIMODEL_DATA_HOME: 'runtime-data',
    CLAUDE_MULTIMODEL_CACHE_HOME: 'runtime-cache',
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: 'user-data',
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: 'claude',
  };
  for (const [key, relative] of Object.entries(directories)) env[key] = path.join(root, relative);
  await Promise.all(
    [...new Set(Object.values(env).filter((value) => value?.startsWith(root)))].map((directory) =>
      mkdir(directory!, { recursive: true, mode: 0o700 })
    )
  );
  if (process.platform === 'win32') {
    // Numeric mkdir modes do not set Windows ownership. This TEST-owned root is
    // precreated here, so give it the same private custody required by the SDK.
    await protectWindowsTestDirectory(env.CLAUDE_MULTIMODEL_DATA_HOME!);
    await protectWindowsTestDirectory(env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!);
  }
  await mkdir(projectPath, { mode: 0o700 });
  if (process.platform === 'win32') await protectWindowsTestDirectory(projectPath);
  await writeFile(path.join(projectPath, '.opencode-e2e-test-project'), teamName + '\n', {
    mode: 0o600,
  });
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  return { root, projectPath, teamName, env };
}
