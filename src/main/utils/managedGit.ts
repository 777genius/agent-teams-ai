import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
    const info = JSON.parse(readFileSync(path.join(root, '.managed-git.json'), 'utf8')) as {
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
  const resolved = findRuntime(options);
  const env = { ...original };
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
  const previousPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
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
  if (!env.GIT_TEMPLATE_DIR && platform !== 'win32') {
    env.GIT_TEMPLATE_DIR = path.join(root, 'share', 'git-core', 'templates');
  }
  if (platform === 'linux') {
    env.PREFIX = root;
    if (!env.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = path.join(root, 'ssl', 'cacert.pem');
  }
  return env;
}
