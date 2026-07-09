import { getErrorMessage } from '@shared/utils/errorHandling';

import { cleanupStaleAnthropicTeamApiKeyHelpers } from '../../runtime/anthropicTeamApiKeyHelper';

export const STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface TeamProvisioningAnthropicApiKeyHelperCleanupLogger {
  warn(message: string): void;
}

export interface TeamProvisioningStaleAnthropicApiKeyHelperCleanupDeps {
  baseClaudeDir: string;
  cleanupStaleHelpers?: typeof cleanupStaleAnthropicTeamApiKeyHelpers;
  logger: TeamProvisioningAnthropicApiKeyHelperCleanupLogger;
  maxAgeMs?: number;
}

export function scheduleStaleAnthropicTeamApiKeyHelperCleanup({
  baseClaudeDir,
  cleanupStaleHelpers = cleanupStaleAnthropicTeamApiKeyHelpers,
  logger,
  maxAgeMs = STALE_ANTHROPIC_TEAM_API_KEY_HELPER_MAX_AGE_MS,
}: TeamProvisioningStaleAnthropicApiKeyHelperCleanupDeps): void {
  void cleanupStaleHelpers({
    baseClaudeDir,
    maxAgeMs,
  }).catch((error: unknown) => {
    logger.warn(
      `Failed to cleanup stale Anthropic team API-key helper material: ${getErrorMessage(error)}`
    );
  });
}
