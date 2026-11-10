import fs from 'node:fs/promises';

import { FileClaudeStateProbe } from '../adapters/output/ClaudeStateProbe';
import { WorkspaceTrustStatusReader } from '../application/WorkspaceTrustStatusReader';
import { validateLaunchTrustRequest } from '../infrastructure/validateLaunchTrustRequest';
import {
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFilesystemGitRoot,
} from '../infrastructure/WorkspaceTrustCanonicalGitRoot';
import { resolveWorkspaceTrustFeatureFlags } from '../infrastructure/WorkspaceTrustFeatureFlags';

import type { LaunchTrustResult, WorkspaceTrustProjectStatusResult } from '../../contracts';

export interface WorkspaceTrustStatusFeatureFacade {
  getLaunchStatus(request: unknown): Promise<LaunchTrustResult>;
  getProjectStatus(request: unknown): Promise<WorkspaceTrustProjectStatusResult>;
}

export function createWorkspaceTrustStatusFeature(input: {
  claudeConfigDir?: string | (() => string);
  globalConfigFilePath: string | (() => string);
  getHomeDir: () => string;
  env?: NodeJS.ProcessEnv;
  isLocalContext?: () => boolean;
}): WorkspaceTrustStatusFeatureFacade {
  const createReader = (): WorkspaceTrustStatusReader =>
    new WorkspaceTrustStatusReader({
      featureFlags: resolveWorkspaceTrustFeatureFlags(input.env),
      stateProbe: {
        readTrustState: (workspace) =>
          new FileClaudeStateProbe({
            claudeConfigDir:
              typeof input.claudeConfigDir === 'function'
                ? input.claudeConfigDir()
                : input.claudeConfigDir,
            globalConfigFilePath: input.globalConfigFilePath,
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
    });

  const getLaunchStatus = async (request: unknown): Promise<LaunchTrustResult> => {
    const valid = validateLaunchTrustRequest(request);
    const unknown: LaunchTrustResult = {
      providers: (valid?.providerIds ?? (['anthropic', 'codex'] as const)).map((providerId) => ({
        providerId,
        status: 'unknown',
      })),
    };
    if (!valid) return unknown;
    try {
      if (input.isLocalContext && !input.isLocalContext()) return unknown;
      return await createReader().readLaunchStatus(valid);
    } catch {
      return unknown;
    }
  };
  return {
    getLaunchStatus,
    getProjectStatus: async (request) => {
      const result = await getLaunchStatus({
        projectPath:
          request && typeof request === 'object' && !Array.isArray(request)
            ? (request as Record<string, unknown>).projectPath
            : undefined,
        providerIds: ['anthropic'],
      });
      const provider = result.providers.find((entry) => entry.providerId === 'anthropic');
      return { status: provider?.status ?? 'unknown' };
    },
  };
}
