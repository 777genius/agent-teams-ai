import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createWorkspaceTrustCoordinator,
  createWorkspaceTrustStatusFeature,
  FileClaudeStateProbe,
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFeatureFlags,
  resolveWorkspaceTrustFilesystemGitRoot,
  WorkspaceTrustStatusReader,
} from '@features/workspace-trust/main';

import type {
  LaunchTrustProviderId,
  LaunchTrustRequest,
} from '@features/workspace-trust/contracts';
import type {
  WorkspaceTrustCoordinator,
  WorkspaceTrustStatusFeatureFacade,
} from '@features/workspace-trust/main';

export interface NodeWorkspaceTrustFeatures {
  coordinator: WorkspaceTrustCoordinator;
  status: WorkspaceTrustStatusFeatureFacade;
}

function validateLaunchTrustRequest(value: unknown): LaunchTrustRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const projectPath = request.projectPath;
  if (
    typeof projectPath !== 'string' ||
    !projectPath.trim() ||
    projectPath.length > 4096 ||
    projectPath.includes('\0') ||
    !path.isAbsolute(projectPath.trim())
  )
    return null;
  if (
    !Array.isArray(request.providerIds) ||
    request.providerIds.length > 32 ||
    !Array.from(request.providerIds).every(
      (provider) => provider === 'anthropic' || provider === 'codex'
    )
  )
    return null;
  return {
    projectPath: projectPath.trim(),
    providerIds: [...new Set(request.providerIds as LaunchTrustProviderId[])].sort(),
  };
}

export function createNodeWorkspaceTrustFeatures(input: {
  getClaudeConfigDir: () => string;
  getAutoDetectedClaudeConfigDir: () => string;
  getHomeDir: () => string;
  env?: NodeJS.ProcessEnv;
  isLocalContext?: () => boolean;
}): NodeWorkspaceTrustFeatures {
  const globalConfigFilePath = (): string => {
    const claudeConfigDir = input.getClaudeConfigDir();
    return path.join(
      claudeConfigDir !== input.getAutoDetectedClaudeConfigDir()
        ? claudeConfigDir
        : input.getHomeDir(),
      '.claude.json'
    );
  };
  const shared = {
    claudeConfigDir: input.getClaudeConfigDir,
    globalConfigFilePath,
  };
  // Read-only status calls must not initialize launch-only provider dependencies.
  let coordinator: WorkspaceTrustCoordinator | undefined;
  const getCoordinator = (): WorkspaceTrustCoordinator =>
    (coordinator ??= createWorkspaceTrustCoordinator(shared));

  return {
    coordinator: {
      planArgsOnly: (request) => getCoordinator().planArgsOnly(request),
      planFull: (request) => getCoordinator().planFull(request),
      execute: (plan) => getCoordinator().execute(plan),
    },
    status: createWorkspaceTrustStatusFeature({
      isLocalContext: input.isLocalContext,
      validateRequest: validateLaunchTrustRequest,
      createReader: () =>
        new WorkspaceTrustStatusReader({
          featureFlags: resolveWorkspaceTrustFeatureFlags(input.env),
          stateProbe: {
            readTrustState: (workspace) =>
              new FileClaudeStateProbe({
                claudeConfigDir: input.getClaudeConfigDir(),
                globalConfigFilePath,
              }).readTrustState(workspace),
          },
          ports: {
            getHomeDir: input.getHomeDir,
            resolvePath: async (value) => {
              try {
                const realPath = await fs.realpath(value);
                return (await fs.stat(realPath)).isDirectory()
                  ? { status: 'resolved', realPath }
                  : { status: 'missing' };
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                return code === 'ENOENT' || code === 'ENOTDIR'
                  ? { status: 'missing' }
                  : { status: 'unknown' };
              }
            },
            resolveGitRoot: async (cwd) => {
              const root = await resolveWorkspaceTrustFilesystemGitRoot(cwd);
              // The directory may disappear while walking git metadata.
              if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Workspace unavailable');
              return root;
            },
            resolveCanonicalGitRoot: resolveWorkspaceTrustCanonicalGitRoot,
            platform: process.platform === 'win32' ? 'win32' : 'posix',
          },
        }),
    }),
  };
}
