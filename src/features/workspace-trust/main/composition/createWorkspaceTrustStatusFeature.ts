import fs from 'node:fs/promises';
import path from 'node:path';

import { FileClaudeStateProbe } from '../adapters/output/ClaudeStateProbe';
import { WorkspaceTrustStatusReader } from '../application/WorkspaceTrustStatusReader';
import {
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFilesystemGitRoot,
} from '../infrastructure/WorkspaceTrustCanonicalGitRoot';
import { resolveWorkspaceTrustFeatureFlags } from '../infrastructure/WorkspaceTrustFeatureFlags';

import type {
  WorkspaceTrustProjectStatusRequest,
  WorkspaceTrustProjectStatusResult,
} from '../../contracts';

export interface WorkspaceTrustStatusFeatureFacade {
  getProjectStatus(
    request: WorkspaceTrustProjectStatusRequest
  ): Promise<WorkspaceTrustProjectStatusResult>;
}

export function resolveWorkspaceTrustGlobalConfigFilePath(input: {
  getClaudeConfigDir: () => string;
  getAutoDetectedClaudeConfigDir: () => string;
  getHomeDir: () => string;
}): string {
  const claudeConfigDir = input.getClaudeConfigDir();
  return path.join(
    claudeConfigDir !== input.getAutoDetectedClaudeConfigDir()
      ? claudeConfigDir
      : input.getHomeDir(),
    '.claude.json'
  );
}

export function createWorkspaceTrustStatusFeature(input: {
  claudeConfigDir?: string | (() => string);
  globalConfigFilePath: string | (() => string);
  getHomeDir: () => string;
  env?: NodeJS.ProcessEnv;
}): WorkspaceTrustStatusFeatureFacade {
  const flags = resolveWorkspaceTrustFeatureFlags(input.env);
  const reader = new WorkspaceTrustStatusReader({
    enabled: flags.enabled && flags.claudePty,
    stateProbe: new FileClaudeStateProbe({
      claudeConfigDir:
        typeof input.claudeConfigDir === 'function'
          ? input.claudeConfigDir()
          : input.claudeConfigDir,
      globalConfigFilePath: input.globalConfigFilePath,
    }),
    ports: {
      getHomeDir: input.getHomeDir,
      resolvePath: async (value) => {
        try {
          return { status: 'resolved', realPath: await fs.realpath(value) };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return code === 'ENOENT' || code === 'ENOTDIR'
            ? { status: 'missing' }
            : { status: 'unknown' };
        }
      },
      resolveGitRoot: resolveWorkspaceTrustFilesystemGitRoot,
      resolveCanonicalGitRoot: resolveWorkspaceTrustCanonicalGitRoot,
      platform: process.platform === 'win32' ? 'win32' : 'posix',
    },
  });

  return {
    getProjectStatus: (request) => reader.read(request),
  };
}
