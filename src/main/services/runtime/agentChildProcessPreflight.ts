import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AgentChildProcessEnvOptions {
  home?: string;
}

export interface AgentChildProcessPreflightOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface WritableRoot {
  label: string;
  dir: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const PREFLIGHT_CACHE = new Set<string>();

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
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
  return `${current?.trim() ? `${current.trim()} ` : ''}-Djava.io.tmpdir="${escapedTempRoot}"`;
}

function getRuntimeCacheBase(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = firstNonEmpty(env.AGENT_STUDIO_RUNNER_CACHE_ROOT, env.STUDIO_AGENT_CACHE_ROOT);
  if (explicit) {
    return path.resolve(explicit);
  }

  const localAppData = firstNonEmpty(env.LOCALAPPDATA, path.join(home, 'AppData', 'Local'));
  return path.join(localAppData, 'AgentStudio', 'runner-cache');
}

export function applyAgentChildProcessWritableEnv(
  env: NodeJS.ProcessEnv,
  options: AgentChildProcessEnvOptions = {},
): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') {
    return env;
  }

  const home = firstNonEmpty(options.home, env.USERPROFILE, env.HOME, os.homedir(), os.tmpdir())!;
  const cacheBase = getRuntimeCacheBase(env, home);
  const tempRoot = path.join(cacheBase, 'tmp');
  const npmCache = path.join(cacheBase, 'npm-cache');
  const gradleHome = path.join(cacheBase, 'gradle-home');
  const androidHome = path.join(cacheBase, 'android-home');
  const commandShell = firstNonEmpty(env.ComSpec, env.COMSPEC, process.env.ComSpec, process.env.COMSPEC, 'cmd.exe')!;

  setPathEnv(env, 'TEMP', tempRoot);
  setPathEnv(env, 'TMP', tempRoot);
  setPathEnv(env, 'TMPDIR', tempRoot);
  setPathEnv(env, 'npm_config_cache', npmCache);
  setPathEnv(env, 'NPM_CONFIG_CACHE', npmCache);
  setPathEnv(env, 'GRADLE_USER_HOME', gradleHome);
  setPathEnv(env, 'ANDROID_USER_HOME', androidHome);
  setPathEnv(env, 'ANDROID_SDK_HOME', androidHome);
  setPathEnv(env, 'npm_config_script_shell', commandShell);
  setPathEnv(env, 'AGENT_STUDIO_NPM_CMD', 'npm.cmd');
  setPathEnv(env, 'AGENT_STUDIO_NPX_CMD', 'npx.cmd');

  env.GRADLE_OPTS = appendJavaTmpDirOption(env.GRADLE_OPTS, tempRoot);
  env.JAVA_TOOL_OPTIONS = appendJavaTmpDirOption(env.JAVA_TOOL_OPTIONS, tempRoot);

  return env;
}

function pushWritableRoot(
  roots: WritableRoot[],
  seen: Set<string>,
  label: string,
  dir: string | undefined,
): void {
  if (!dir?.trim()) {
    return;
  }
  const resolved = path.resolve(dir);
  const key = resolved.toLowerCase();
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  roots.push({ label, dir: resolved });
}

function getWritableRoots(env: NodeJS.ProcessEnv, cwd?: string): WritableRoot[] {
  const roots: WritableRoot[] = [];
  const seen = new Set<string>();

  pushWritableRoot(roots, seen, 'TEMP', env.TEMP);
  pushWritableRoot(roots, seen, 'TMP', env.TMP);
  pushWritableRoot(roots, seen, 'npm_config_cache', firstNonEmpty(env.npm_config_cache, env.NPM_CONFIG_CACHE));
  pushWritableRoot(roots, seen, 'GRADLE_USER_HOME', env.GRADLE_USER_HOME);
  pushWritableRoot(roots, seen, 'ANDROID_USER_HOME', env.ANDROID_USER_HOME);
  pushWritableRoot(roots, seen, 'ANDROID_SDK_HOME', env.ANDROID_SDK_HOME);
  pushWritableRoot(roots, seen, 'cwd', cwd);

  return roots;
}

async function verifyWritableRoot(root: WritableRoot): Promise<void> {
  await fs.promises.mkdir(root.dir, { recursive: true });
  const probePath = path.join(root.dir, `.agent-studio-write-probe-${process.pid}-${Date.now()}.tmp`);
  await fs.promises.writeFile(probePath, 'ok', 'utf8');
  const written = await fs.promises.readFile(probePath, 'utf8');
  if (written !== 'ok') {
    throw new Error(`${root.label} write probe read back unexpected content`);
  }
  await fs.promises.unlink(probePath);
}

function summarizeSpawnFailure(label: string, result: SpawnSyncReturns<string>): string | null {
  if (result.error) {
    return `${label}: ${result.error.message}`;
  }
  if (result.signal) {
    return `${label}: terminated by ${result.signal}`;
  }
  if (result.status && result.status !== 0) {
    const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    return `${label}: exited ${result.status}${output ? ` (${output.slice(0, 240)})` : ''}`;
  }
  return null;
}

function runNodeChildSpawnProbe(env: NodeJS.ProcessEnv, cwd: string | undefined, timeoutMs: number): string | null {
  const script =
    "const r=require('child_process').spawnSync(process.execPath,['-v'],{encoding:'utf8'});" +
    "if(r.error){console.error(r.error.message);process.exit(1)}" +
    "if(r.status!==0){process.stderr.write((r.stderr||'')+(r.stdout||''));process.exit(r.status||1)}" +
    "process.stdout.write((r.stdout||'').trim())";
  const result = spawnSync('node.exe', ['-e', script], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return summarizeSpawnFailure('node child_process spawnSync probe', result);
}

function runCmdShimVersion(
  command: 'npm.cmd' | 'npx.cmd',
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  timeoutMs: number,
): string | null {
  const comspec = firstNonEmpty(env.ComSpec, env.COMSPEC, process.env.ComSpec, process.env.COMSPEC, 'cmd.exe')!;
  const result = spawnSync(comspec, ['/d', '/s', '/c', `${command} --version`], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return summarizeSpawnFailure(`${command} --version`, result);
}

export async function assertAgentChildProcessPreflight(
  options: AgentChildProcessPreflightOptions,
): Promise<void> {
  if (process.platform !== 'win32' || options.env.AGENT_STUDIO_SKIP_CHILD_PROCESS_PREFLIGHT === '1') {
    return;
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : undefined;
  const roots = getWritableRoots(options.env, cwd);
  const cacheKey = roots.map((root) => root.dir.toLowerCase()).sort().join('|');
  if (PREFLIGHT_CACHE.has(cacheKey)) {
    return;
  }

  const failures: string[] = [];
  for (const root of roots) {
    try {
      await verifyWritableRoot(root);
    } catch (error) {
      failures.push(`${root.label} (${root.dir}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandFailures = [
    runNodeChildSpawnProbe(options.env, cwd, timeoutMs),
    runCmdShimVersion('npm.cmd', options.env, cwd, timeoutMs),
    runCmdShimVersion('npx.cmd', options.env, cwd, timeoutMs),
  ].filter((failure): failure is string => Boolean(failure));

  failures.push(...commandFailures);

  if (failures.length) {
    throw new Error(`Agent child-process preflight failed:\n- ${failures.join('\n- ')}`);
  }

  PREFLIGHT_CACHE.add(cacheKey);
}
