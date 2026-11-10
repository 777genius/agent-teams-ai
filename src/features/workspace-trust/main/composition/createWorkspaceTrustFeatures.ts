import path from 'node:path';

import { createWorkspaceTrustCoordinator } from './createWorkspaceTrustCoordinator';
import { createWorkspaceTrustStatusFeature } from './createWorkspaceTrustStatusFeature';

export function createWorkspaceTrustFeatures(input: {
  getClaudeConfigDir: () => string;
  getAutoDetectedClaudeConfigDir: () => string;
  getHomeDir: () => string;
  env?: NodeJS.ProcessEnv;
  isLocalContext?: () => boolean;
}) {
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
  return {
    coordinator: createWorkspaceTrustCoordinator(shared),
    status: createWorkspaceTrustStatusFeature({
      ...shared,
      getHomeDir: input.getHomeDir,
      env: input.env,
      isLocalContext: input.isLocalContext,
    }),
  };
}
