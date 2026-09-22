import {
  getCodexChatGptUnavailableModelReason,
  isCodexChatGptAuthProviderStatus,
} from '@shared/utils/codexChatGptModelSupport';

import type { CliProviderId, CliProviderStatus, TeamProviderId } from '@shared/types';

type SupportedProviderId = CliProviderId | TeamProviderId;

export type CodexChatGptGateProviderStatus = Pick<
  CliProviderStatus,
  'providerId' | 'authMethod' | 'backend' | 'connection' | 'modelAvailability'
>;

export const GPT_5_1_CODEX_MAX_CHATGPT_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model is not currently available on the Codex native runtime.';
export const CODEX_CHATGPT_UNSUPPORTED_MODEL_UI_DISABLED_REASON =
  'Not available when Codex uses a ChatGPT account - the runtime reported this model as unsupported. Switch Codex authentication to an API key to use it.';

export function isCodexChatGptSubscriptionProviderStatus(
  providerStatus?: CodexChatGptGateProviderStatus | null
): boolean {
  if (providerStatus?.providerId !== 'codex') {
    return false;
  }

  return isCodexChatGptAuthProviderStatus(providerStatus);
}

/**
 * Codex models that are unusable with a ChatGPT account: the static known set
 * plus any model the runtime availability probe reported as ChatGPT-gated
 * (for example gpt-5.2, which stays visible in the live catalog but fails
 * exec with "not supported when using Codex with a ChatGPT account").
 */
const CODEX_CHATGPT_STATIC_HIDDEN_MODEL_REASONS: Readonly<Record<string, string>> = {
  'gpt-5.1-codex-max': GPT_5_1_CODEX_MAX_CHATGPT_UI_DISABLED_REASON,
};

export function getCodexChatGptModeUiDisabledReason(
  providerId: SupportedProviderId,
  model: string,
  providerStatus?: CodexChatGptGateProviderStatus | null
): string | null {
  if (providerId !== 'codex' || !isCodexChatGptSubscriptionProviderStatus(providerStatus)) {
    return null;
  }

  const staticReason = CODEX_CHATGPT_STATIC_HIDDEN_MODEL_REASONS[model];
  if (staticReason) {
    return staticReason;
  }

  return getCodexChatGptUnavailableModelReason({ providerStatus, modelId: model })
    ? CODEX_CHATGPT_UNSUPPORTED_MODEL_UI_DISABLED_REASON
    : null;
}
