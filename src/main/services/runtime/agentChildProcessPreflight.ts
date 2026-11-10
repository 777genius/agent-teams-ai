import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AgentChildProcessEnvOptions {
  home?: string;
}

export interface AgentChildProcessWritableEnvResult {
  applied: boolean;
  cacheBase?: string;
  warning?: string;
}

interface AgentChildProcessWritableEnvPaths {
  cacheBase: string;
  tempRoot: string;
  npmCache: string;
  gradleHome: string;
  androidHome: string;
  commandShell: string;
}

interface AgentChildProcessWritableDirectory {
  label: string;
  dir: string;
}

function firstNonEmpty(...values: (string | undefined | null)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setPathEnv(env: NodeJS.ProcessEnv, key: string, value: string): string {
  env[key] = value;
  return value;
}

function appendJavaTmpDirOption(current: string | undefined, tempRoot: string): string {
  if (current?.includes('-Djava.io.tmpdir=')) {
    return current;
  }
  const escapedTempRoot = tempRoot.replace(/"/g, '\\"');
  const prefix = current?.trim() ? `${current.trim()} ` : '';
  return `${prefix}-Djava.io.tmpdir="${escapedTempRoot}"`;
}

function getRuntimeCacheBase(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = firstNonEmpty(env.AGENT_STUDIO_RUNNER_CACHE_ROOT, env.STUDIO_AGENT_CACHE_ROOT);
  if (explicit) {
    return path.resolve(explicit);
  }

  const localAppData = firstNonEmpty(env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local');
  return path.join(localAppData, 'AgentStudio', 'runner-cache');
}

function resolveWritableEnvPaths(
  env: NodeJS.ProcessEnv,
  options: AgentChildProcessEnvOptions
): AgentChildProcessWritableEnvPaths {
  const home = firstNonEmpty(options.home, env.USERPROFILE, env.HOME, os.homedir()) ?? os.tmpdir();
  const cacheBase = getRuntimeCacheBase(env, home);
  const tempRoot = path.join(cacheBase, 'tmp');
  const commandShell =
    firstNonEmpty(env.ComSpec, env.COMSPEC, process.env.ComSpec, process.env.COMSPEC) ?? 'cmd.exe';

  return {
    cacheBase,
    tempRoot,
    npmCache: path.join(cacheBase, 'npm-cache'),
    gradleHome: path.join(cacheBase, 'gradle-home'),
    androidHome: path.join(cacheBase, 'android-home'),
    commandShell,
  };
}

function applyResolvedWritableEnv(
  env: NodeJS.ProcessEnv,
  paths: AgentChildProcessWritableEnvPaths
): NodeJS.ProcessEnv {
  setPathEnv(env, 'TEMP', paths.tempRoot);
  setPathEnv(env, 'TMP', paths.tempRoot);
  setPathEnv(env, 'TMPDIR', paths.tempRoot);
  setPathEnv(env, 'npm_config_cache', paths.npmCache);
  setPathEnv(env, 'NPM_CONFIG_CACHE', paths.npmCache);
  setPathEnv(env, 'GRADLE_USER_HOME', paths.gradleHome);
  setPathEnv(env, 'ANDROID_USER_HOME', paths.androidHome);
  setPathEnv(env, 'ANDROID_SDK_HOME', paths.androidHome);
  setPathEnv(env, 'npm_config_script_shell', paths.commandShell);
  setPathEnv(env, 'AGENT_STUDIO_NPM_CMD', 'npm.cmd');
  setPathEnv(env, 'AGENT_STUDIO_NPX_CMD', 'npx.cmd');

  env.GRADLE_OPTS = appendJavaTmpDirOption(env.GRADLE_OPTS, paths.tempRoot);
  env.JAVA_TOOL_OPTIONS = appendJavaTmpDirOption(env.JAVA_TOOL_OPTIONS, paths.tempRoot);

  return env;
}

async function ensureWritableDirectory(root: AgentChildProcessWritableDirectory): Promise<void> {
  try {
    await fs.promises.mkdir(root.dir, { recursive: true });

    const probePath = path.join(
      root.dir,
      `.agent-studio-write-probe-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.tmp`
    );
    let probeCreated = false;
    let cleanupError: unknown;

    try {
      await fs.promises.writeFile(probePath, 'ok', 'utf8');
      probeCreated = true;

      const written = await fs.promises.readFile(probePath, 'utf8');
      if (written !== 'ok') {
        throw new Error('write probe read back unexpected content');
      }
    } finally {
      if (probeCreated) {
        try {
          await fs.promises.unlink(probePath);
        } catch (error) {
          cleanupError = error;
        }
      }
    }

    if (cleanupError) {
      throw new Error(`write probe cleanup failed: ${errorMessage(cleanupError)}`);
    }
  } catch (error) {
    throw new Error(`${root.label} at ${root.dir} failed writable check: ${errorMessage(error)}`);
  }
}

export function applyAgentChildProcessWritableEnv(
  env: NodeJS.ProcessEnv,
  options: AgentChildProcessEnvOptions = {}
): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') {
    return env;
  }

  return applyResolvedWritableEnv(env, resolveWritableEnvPaths(env, options));
}

export async function prepareAgentChildProcessWritableEnv(
  env: NodeJS.ProcessEnv,
  options: AgentChildProcessEnvOptions = {}
): Promise<AgentChildProcessWritableEnvResult> {
  if (process.platform !== 'win32') {
    return { applied: false };
  }

  const paths = resolveWritableEnvPaths(env, options);
  const dirs: AgentChildProcessWritableDirectory[] = [
    { label: 'TEMP/TMP/TMPDIR', dir: paths.tempRoot },
    { label: 'npm cache', dir: paths.npmCache },
    { label: 'Gradle home', dir: paths.gradleHome },
    { label: 'Android home', dir: paths.androidHome },
  ];
  try {
    const checks = await Promise.allSettled(dirs.map((dir) => ensureWritableDirectory(dir)));
    const failed = checks.find((check) => check.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason;
    }

    applyResolvedWritableEnv(env, paths);
    return { applied: true, cacheBase: paths.cacheBase };
  } catch (error) {
    return {
      applied: false,
      cacheBase: paths.cacheBase,
      warning:
        `Windows agent writable cache setup skipped for ${paths.cacheBase}; ` +
        `keeping existing temp/cache env. Details: ${errorMessage(error)}`,
    };
  }
}
