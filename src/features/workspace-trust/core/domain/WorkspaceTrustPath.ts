import path from 'node:path';

import type {
  WorkspaceTrustNonPersistableReason,
  WorkspaceTrustWorkspace,
  WorkspaceTrustWorkspaceSource,
} from './WorkspaceTrustTypes';

export type WorkspaceTrustPathPlatform = 'posix' | 'win32';

export interface WorkspaceTrustPathOptions {
  platform?: WorkspaceTrustPathPlatform;
}

export type BuildWorkspaceTrustPathCandidatesInput = WorkspaceTrustPathOptions & {
  cwd: string;
  realCwd?: string | null;
  gitRoot?: string | null;
  homeDir?: string | null;
  source?: WorkspaceTrustWorkspaceSource;
  memberId?: string;
};

const WORKSPACE_ID_PREFIX = 'workspace-trust';

function defaultPlatform(): WorkspaceTrustPathPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function pathForPlatform(platform: WorkspaceTrustPathPlatform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function withPlatform(options?: WorkspaceTrustPathOptions): WorkspaceTrustPathPlatform {
  return options?.platform ?? defaultPlatform();
}

function isBlank(value: string | null | undefined): value is '' | null | undefined {
  return typeof value !== 'string' || value.trim().length === 0;
}

function trimTrailingSeparators(value: string, platform: WorkspaceTrustPathPlatform): string {
  const pathApi = pathForPlatform(platform);
  const root = pathApi.parse(value).root;
  let output = value;
  while (output.length > root.length && /[\\/]$/.test(output)) {
    output = output.slice(0, -1);
  }
  return output;
}

export function normalizeWorkspaceTrustConfigKey(
  value: string,
  options?: WorkspaceTrustPathOptions
): string {
  if (isBlank(value)) {
    return '';
  }
  const platform = withPlatform(options);
  const pathApi = pathForPlatform(platform);
  const normalized = trimTrailingSeparators(pathApi.normalize(value), platform);
  return normalized.replace(/\\/g, '/');
}

export function normalizeWorkspaceTrustComparisonKey(
  value: string,
  options?: WorkspaceTrustPathOptions
): string {
  const platform = withPlatform(options);
  const configKey = normalizeWorkspaceTrustConfigKey(value, { platform });
  return platform === 'win32' ? configKey.toLowerCase() : configKey;
}

export function collectWorkspaceTrustParentConfigKeys(
  value: string,
  options?: WorkspaceTrustPathOptions
): string[] {
  if (isBlank(value)) {
    return [];
  }

  const platform = withPlatform(options);
  const pathApi = pathForPlatform(platform);
  const keys: string[] = [];
  const seen = new Set<string>();
  let current = trimTrailingSeparators(pathApi.normalize(value), platform);

  while (current) {
    const configKey = normalizeWorkspaceTrustConfigKey(current, { platform });
    if (!seen.has(configKey)) {
      seen.add(configKey);
      keys.push(configKey);
    }

    const parent = pathApi.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return keys;
}

export function isFilesystemRootWorkspacePath(
  value: string,
  options?: WorkspaceTrustPathOptions
): boolean {
  if (isBlank(value)) {
    return false;
  }
  const platform = withPlatform(options);
  const pathApi = pathForPlatform(platform);
  const normalized = trimTrailingSeparators(pathApi.normalize(value), platform);
  return normalized === pathApi.parse(normalized).root;
}

export function getWorkspaceTrustNonPersistableReason(
  value: string,
  options?: WorkspaceTrustPathOptions & { homeDir?: string | null }
): WorkspaceTrustNonPersistableReason | undefined {
  if (isBlank(value)) {
    return 'unavailable';
  }
  const platform = withPlatform(options);
  if (isFilesystemRootWorkspacePath(value, { platform })) {
    return 'filesystem_root';
  }
  const homeDir = options?.homeDir;
  if (!isBlank(homeDir)) {
    const valueKey = normalizeWorkspaceTrustComparisonKey(value, { platform });
    const homeKey = normalizeWorkspaceTrustComparisonKey(homeDir, { platform });
    if (valueKey === homeKey) {
      return 'home_directory';
    }
  }
  return undefined;
}

function stableWorkspaceId(
  source: WorkspaceTrustWorkspaceSource,
  comparisonKey: string,
  memberId?: string
): string {
  const owner = memberId ? `${source}:${memberId}` : source;
  return `${WORKSPACE_ID_PREFIX}:${owner}:${comparisonKey}`;
}

function buildWorkspace(
  input: BuildWorkspaceTrustPathCandidatesInput & {
    cwd: string;
    displayCwd: string;
    source: WorkspaceTrustWorkspaceSource;
    gitRootConfigKey?: string;
  }
): WorkspaceTrustWorkspace | null {
  const platform = withPlatform(input);
  if (isBlank(input.cwd)) {
    return null;
  }

  const configKeyCwd = normalizeWorkspaceTrustConfigKey(input.cwd, { platform });
  const comparisonKey = normalizeWorkspaceTrustComparisonKey(input.cwd, { platform });
  const reason = getWorkspaceTrustNonPersistableReason(input.cwd, {
    platform,
    homeDir: input.homeDir,
  });

  return {
    id: stableWorkspaceId(input.source, comparisonKey, input.memberId),
    displayCwd: input.displayCwd,
    cwd: input.cwd,
    realCwd: input.realCwd || input.cwd,
    configKeyCwd,
    gitRootConfigKey: input.gitRootConfigKey,
    comparisonKey,
    source: input.source,
    memberId: input.memberId,
    persistable: !reason,
    nonPersistableReason: reason,
  };
}

export function dedupeWorkspaceTrustWorkspaces(
  workspaces: WorkspaceTrustWorkspace[]
): WorkspaceTrustWorkspace[] {
  const output: WorkspaceTrustWorkspace[] = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    if (seen.has(workspace.comparisonKey)) {
      continue;
    }
    seen.add(workspace.comparisonKey);
    output.push(workspace);
  }
  return output;
}

export function buildWorkspaceTrustPathCandidates(
  input: BuildWorkspaceTrustPathCandidatesInput
): WorkspaceTrustWorkspace[] {
  const platform = withPlatform(input);
  const source = input.source ?? 'team-root';
  const gitRootConfigKey = isBlank(input.gitRoot)
    ? undefined
    : normalizeWorkspaceTrustConfigKey(input.gitRoot, { platform });
  const candidates: WorkspaceTrustWorkspace[] = [];

  const primary = buildWorkspace({
    ...input,
    platform,
    cwd: input.cwd,
    displayCwd: input.cwd,
    realCwd: input.realCwd || input.cwd,
    source,
    gitRootConfigKey,
  });
  if (primary) {
    candidates.push(primary);
  }

  if (!isBlank(input.realCwd)) {
    const real = buildWorkspace({
      ...input,
      platform,
      cwd: input.realCwd,
      displayCwd: input.cwd,
      realCwd: input.realCwd,
      source,
      gitRootConfigKey,
    });
    if (real) {
      candidates.push(real);
    }
  }

  if (!isBlank(input.gitRoot)) {
    const gitRoot = buildWorkspace({
      ...input,
      platform,
      cwd: input.gitRoot,
      displayCwd: input.gitRoot,
      realCwd: input.gitRoot,
      source: 'git-root',
      gitRootConfigKey,
    });
    if (gitRoot) {
      candidates.push(gitRoot);
    }
  }

  return dedupeWorkspaceTrustWorkspaces(candidates);
}
