import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Environment entries required by the portable Git helpers (not user credentials). */
export const MANAGED_GIT_ENV_KEYS = [
  'PATH',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_SYSTEM',
  'GIT_SSL_CAINFO',
  'PREFIX',
] as const;

interface GitRuntimeLocation {
  executable: string;
  root: string | null;
}

export interface ManagedGitLocationOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string;
  developmentRoot?: string;
  packaged?: boolean;
  /** Include Linux's process-wide PREFIX only when directly executing Git. */
  gitCommand?: boolean;
}

function findRuntime(options: ManagedGitLocationOptions = {}): GitRuntimeLocation {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const packaged =
    options.packaged ?? Boolean(resourcesPath && existsSync(path.join(resourcesPath, 'app.asar')));
  const root = packaged
    ? path.join(resourcesPath!, 'git')
    : path.join(options.developmentRoot ?? process.cwd(), 'resources', 'git');
  const executable = path.join(root, platform === 'win32' ? 'cmd/git.exe' : 'bin/git');

  try {
    const info = JSON.parse(readFileSync(path.join(root, 'MANAGED_GIT.json'), 'utf8')) as {
      platform?: string;
      sha256?: string;
    };
    if (info.platform === `${platform}-${arch}` && /^[a-f0-9]{64}$/.test(info.sha256 ?? '') && existsSync(executable)) {
      return { executable, root };
    }
  } catch {
    // Source checkouts can run without staging the release Git payload.
  }

  if (packaged) {
    throw new Error(
      'Agent Teams bundled Git is missing or invalid. Reinstall Agent Teams to restore Git support.'
    );
  }
  return { executable: 'git', root: null };
}

/** Use a pinned absolute binary in installed apps, never Apple's /usr/bin/git shim. */
export function getManagedGitExecutable(options: ManagedGitLocationOptions = {}): string {
  return findRuntime(options).executable;
}

/**
 * Only the child receives these settings. Do not mutate process.env or alter
 * the user's global Git configuration and SSH/credential-helper settings.
 */
export function createManagedGitEnv(
  original: NodeJS.ProcessEnv,
  options: ManagedGitLocationOptions = {}
): NodeJS.ProcessEnv {
  const env = { ...original };
  let resolved: GitRuntimeLocation;
  try {
    resolved = findRuntime(options);
  } catch {
    // Ordinary teams/terminals must remain usable when the packaged Git payload
    // is missing; explicit Git commands still fail via getManagedGitExecutable().
    return env;
  }
  if (!resolved.root) return env;

  const platform = options.platform ?? process.platform;
  const root = resolved.root;
  const dirs = platform === 'win32'
    ? [
        path.join(root, 'cmd'),
        path.join(root, (options.arch ?? process.arch) === 'arm64' ? 'clangarm64' : 'ucrt64', 'bin'),
        path.join(root, (options.arch ?? process.arch) === 'arm64' ? 'clangarm64' : 'ucrt64', 'usr', 'bin'),
      ]
    : [path.join(root, 'bin')];

  // Windows treats PATH/Path as the same variable; avoid duplicate keys.
  const previousPath = env.PATH ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
    }
  }
  const separator = platform === 'win32' ? ';' : ':';
  env.PATH = [...new Set([
    ...dirs,
    ...(previousPath ?? '').split(separator).filter(Boolean),
  ])].join(separator);
  env.GIT_EXEC_PATH = platform === 'win32'
    ? path.join(root, (options.arch ?? process.arch) === 'arm64' ? 'clangarm64' : 'ucrt64', 'libexec', 'git-core')
    : path.join(root, 'libexec', 'git-core');

  if (!env.GIT_CONFIG_SYSTEM && platform !== 'win32') {
    env.GIT_CONFIG_SYSTEM = path.join(root, 'etc', 'gitconfig');
  }
  // PREFIX is generic and can redirect make/install/build commands. Set it
  // only for our direct Git subprocesses, not in agent/terminal environments.
  // Do not set GIT_SSL_CAINFO: that would override a user's http.sslCAInfo.
  if (platform === 'linux' && options.gitCommand) env.PREFIX = root;
  return env;
}
