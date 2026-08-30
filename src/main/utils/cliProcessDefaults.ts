/**
 * Shared option/env defaults for every spawned agent runtime CLI process.
 *
 * `withCliProcessDefaults` is the single seam that `execCli`/`spawnCli` (and
 * therefore every lead/member CLI launch, the OpenCode bridge, and the hosts
 * plus shell children those processes spawn) route their options through.
 */

import * as os from 'os';
import path from 'path';

/** Env vars injected into every spawned agent runtime CLI process. */
const CLI_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_HOOK_JUDGE_MODE: 'true',
};

export interface EnsureWindowsSpawnBaseDirEnvOptions {
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  homedir?: () => string;
  tmpdir?: () => string;
}

/** Windows env lookups are case-insensitive; plain env objects are not. */
function findEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (name in env) {
    return name;
  }
  const lowered = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lowered);
}

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = findEnvKey(env, name);
  const value = key ? env[key]?.trim() : undefined;
  return value || undefined;
}

/** Overwrite the existing (possibly differently-cased) key to avoid duplicates. */
function setEnvValue(env: NodeJS.ProcessEnv, name: string, value: string): void {
  env[findEnvKey(env, name) ?? name] = value;
}

function safeHomedir(homedir: () => string): string | undefined {
  try {
    return homedir()?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Guarantee that a Windows spawn env carries non-empty per-user base
 * directories (LOCALAPPDATA/APPDATA/TEMP/TMP).
 *
 * Spawn envs are assembled from snapshots (process.env, cached shell env,
 * provider patch layers), so a missing or empty value silently propagates to
 * every spawned runtime CLI and its descendants. Windows PowerShell resolves
 * its module analysis cache under %LOCALAPPDATA%; with LOCALAPPDATA
 * missing/empty it falls back to a cwd-RELATIVE path, so agent shell children
 * littered team workspaces with Microsoft/Windows/PowerShell/ModuleAnalysisCache
 * directories. Fill-only: existing non-empty values (including deliberate
 * TEMP/TMP redirects) are never overridden.
 */
export function ensureWindowsSpawnBaseDirEnv(
  env: NodeJS.ProcessEnv,
  options: EnsureWindowsSpawnBaseDirEnvOptions = {}
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return env;
  }
  const processEnv = options.processEnv ?? process.env;

  const home =
    readEnvValue(env, 'USERPROFILE') ??
    readEnvValue(env, 'HOME') ??
    readEnvValue(processEnv, 'USERPROFILE') ??
    readEnvValue(processEnv, 'HOME') ??
    safeHomedir(options.homedir ?? os.homedir);
  const localAppData =
    readEnvValue(env, 'LOCALAPPDATA') ??
    readEnvValue(processEnv, 'LOCALAPPDATA') ??
    (home ? path.win32.join(home, 'AppData', 'Local') : undefined);
  const appData =
    readEnvValue(env, 'APPDATA') ??
    readEnvValue(processEnv, 'APPDATA') ??
    (home ? path.win32.join(home, 'AppData', 'Roaming') : undefined);
  const temp =
    readEnvValue(env, 'TEMP') ??
    readEnvValue(env, 'TMP') ??
    readEnvValue(processEnv, 'TEMP') ??
    readEnvValue(processEnv, 'TMP') ??
    (localAppData ? path.win32.join(localAppData, 'Temp') : (options.tmpdir ?? os.tmpdir)());

  if (localAppData && !readEnvValue(env, 'LOCALAPPDATA')) {
    setEnvValue(env, 'LOCALAPPDATA', localAppData);
  }
  if (appData && !readEnvValue(env, 'APPDATA')) {
    setEnvValue(env, 'APPDATA', appData);
  }
  if (!readEnvValue(env, 'TEMP')) {
    setEnvValue(env, 'TEMP', temp);
  }
  if (!readEnvValue(env, 'TMP')) {
    setEnvValue(env, 'TMP', temp);
  }
  // Last resort when no user profile is resolvable at all: pin the PowerShell
  // module analysis cache to the temp dir so it can never land in the cwd.
  if (!localAppData && !readEnvValue(env, 'PSModuleAnalysisCachePath')) {
    setEnvValue(env, 'PSModuleAnalysisCachePath', path.win32.join(temp, 'PSModuleAnalysisCache'));
  }
  return env;
}

/** Apply shared CLI process defaults without overriding explicit caller choices. */
export function withCliProcessDefaults<
  T extends {
    detached?: boolean;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    windowsHide?: boolean;
  },
>(options: T): T & { detached: boolean; windowsHide: boolean } {
  return {
    ...options,
    detached: options.detached ?? process.platform !== 'win32',
    windowsHide: options.windowsHide ?? true,
    env: ensureWindowsSpawnBaseDirEnv({ ...(options.env ?? process.env), ...CLI_ENV_DEFAULTS }),
  };
}
