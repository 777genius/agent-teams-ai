import type { CliProviderStatus } from '@shared/types';

/**
 * Exact failure signature the Codex runtime returns (HTTP 400 invalid_request_error)
 * when a launch model exists in the live catalog but is gated for ChatGPT accounts:
 * "The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account."
 */
export const CODEX_CHATGPT_UNSUPPORTED_MODEL_MESSAGE_PATTERN =
  /The '([^']+)' model is not supported when using Codex with a ChatGPT account/i;

/**
 * Normalized probe reason used by the model availability service for the
 * ChatGPT-gated signature. Kept here so main-process normalization and the
 * shared classification stay in sync.
 */
export const CODEX_CHATGPT_UNSUPPORTED_MODEL_NORMALIZED_REASON =
  'Not available on this Codex native runtime';

export type CodexChatGptAwareProviderStatus = Partial<
  Pick<
    CliProviderStatus,
    'providerId' | 'authMethod' | 'backend' | 'connection' | 'modelAvailability'
  >
> | null;

export function isCodexChatGptAuthProviderStatus(
  providerStatus: CodexChatGptAwareProviderStatus | undefined
): boolean {
  if (!providerStatus) {
    return false;
  }
  if (providerStatus.providerId != null && providerStatus.providerId !== 'codex') {
    return false;
  }

  return (
    providerStatus.authMethod === 'chatgpt' ||
    providerStatus.backend?.authMethodDetail === 'chatgpt' ||
    providerStatus.connection?.codex?.effectiveAuthMode === 'chatgpt'
  );
}

export function isCodexChatGptUnsupportedModelMessage(message: string | null | undefined): boolean {
  const trimmed = message?.trim();
  if (!trimmed) {
    return false;
  }
  if (CODEX_CHATGPT_UNSUPPORTED_MODEL_MESSAGE_PATTERN.test(trimmed)) {
    return true;
  }

  // The runtime gates models behind invalid_request_error responses; treat any
  // such error that names the model as unsupported the same way so new message
  // phrasings still fail closed in ChatGPT mode.
  return (
    /invalid_request_error/i.test(trimmed) &&
    /\bmodel\b/i.test(trimmed) &&
    /not supported|unsupported/i.test(trimmed)
  );
}

export function buildCodexChatGptUnsupportedModelReason(modelId: string): string {
  return (
    `The '${modelId}' model is not supported when using Codex with a ChatGPT account. ` +
    'Switch Codex authentication to an API key or pick a ChatGPT-supported Codex model.'
  );
}

/**
 * Pure classification over provider status facts: returns the user-facing
 * unsupported reason when the runtime availability probe reported the selected
 * model as ChatGPT-incompatible while the Codex runtime uses a ChatGPT account.
 */
export function getCodexChatGptUnavailableModelReason(params: {
  providerStatus: CodexChatGptAwareProviderStatus | undefined;
  modelId: string | undefined;
}): string | null {
  const modelId = params.modelId?.trim();
  if (!modelId || !isCodexChatGptAuthProviderStatus(params.providerStatus)) {
    return null;
  }

  const entry = params.providerStatus?.modelAvailability?.find(
    (item) => item.modelId.trim() === modelId
  );
  if (!entry || entry.status === 'available' || entry.status === 'checking') {
    return null;
  }

  const reason = entry.reason?.trim();
  const reasonIndicatesChatGptGate =
    isCodexChatGptUnsupportedModelMessage(reason) ||
    reason === CODEX_CHATGPT_UNSUPPORTED_MODEL_NORMALIZED_REASON;
  if (!reasonIndicatesChatGptGate) {
    return null;
  }

  return buildCodexChatGptUnsupportedModelReason(modelId);
}
