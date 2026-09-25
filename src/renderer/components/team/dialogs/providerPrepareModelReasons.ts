import { getOpenCodeQualifiedModelSourceLabel } from '@shared/utils/opencodeModelRef';

import type { TeamProvisioningPrepareResult } from '@shared/types';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripSelectedModelPrefix(modelId: string, message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return trimmed;
  }

  const patterns = [
    new RegExp(`^Selected model ${escapeRegExp(modelId)} is unavailable\\.\\s*`, 'i'),
    new RegExp(`^Selected model ${escapeRegExp(modelId)} could not be verified\\.\\s*`, 'i'),
    new RegExp(`^Selected model ${escapeRegExp(modelId)} verification deferred\\.\\s*`, 'i'),
    new RegExp(
      `^Selected model ${escapeRegExp(modelId)} verified for launch with Agent Teams tool coordination\\.\\s*`,
      'i'
    ),
    new RegExp(`^Selected model ${escapeRegExp(modelId)} verified for launch\\.\\s*`, 'i'),
    new RegExp(`^Selected model ${escapeRegExp(modelId)} is available for launch\\.\\s*`, 'i'),
    new RegExp(
      `^Selected model ${escapeRegExp(modelId)} is compatible\\. Deep verification pending\\.\\s*`,
      'i'
    ),
  ];
  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, '').trim();
    }
  }

  return trimmed;
}

function decodeQuotedJsonString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value;
  }
}

export function normalizeProviderAccountFailure(rawReason: string): string | null {
  if (/not licensed to use copilot/i.test(rawReason)) {
    return 'GitHub account connected, but this account does not have an active Copilot license';
  }
  if (
    /payment required|used all available credits|monthly spending limit|insufficient credits/i.test(
      rawReason
    )
  ) {
    return 'Provider account has no available credits or reached its spending limit';
  }
  if (/invalid authentication credentials/i.test(rawReason)) {
    return 'Provider credentials were rejected. Reconnect the account and retry';
  }
  return null;
}

export function normalizeModelReason(
  rawReason: string | null | undefined,
  modelId?: string
): string | null {
  const trimmed = rawReason?.trim() ?? '';
  if (!trimmed) {
    return null;
  }

  const credentialProviderLabel = getOpenCodeQualifiedModelSourceLabel(modelId) ?? null;
  if (
    /\binvalid[\s_-]+api[\s_-]*key\b/i.test(trimmed) ||
    /\bapi[\s_-]*key\s+(?:is\s+)?(?:invalid|expired|revoked)\b/i.test(trimmed)
  ) {
    const providerLabel = credentialProviderLabel ?? 'OpenCode provider';
    return `${providerLabel} rejected its API key. Reconnect ${providerLabel} in Plans & providers`;
  }
  if (/access denied by security policy/i.test(trimmed)) {
    const providerLabel = credentialProviderLabel ?? 'OpenCode provider';
    return `${providerLabel} blocked the request by account or security policy. Review its key restrictions, then reconnect it in Plans & providers`;
  }

  if (
    /The '[^']+' model is not supported when using Codex with a ChatGPT account\./i.test(trimmed)
  ) {
    return 'Not available on this Codex native runtime';
  }
  if (/The requested model is not available for your account\./i.test(trimmed)) {
    return 'Not available for this account';
  }
  const accountFailure = normalizeProviderAccountFailure(trimmed);
  if (accountFailure) {
    return accountFailure;
  }
  if (/token refresh failed:\s*401/i.test(trimmed)) {
    return 'OpenCode provider authentication failed (token refresh 401)';
  }
  if (/unauthorized|forbidden|\b401\b|\b403\b/i.test(trimmed)) {
    return 'OpenCode provider authentication failed';
  }
  if (
    trimmed.toLowerCase().includes('timeout running:') ||
    trimmed.toLowerCase().includes('timed out') ||
    trimmed.toLowerCase().includes('etimedout')
  ) {
    return 'Model verification timed out';
  }

  const detailMatch = /"detail":"((?:\\"|[^"])*)"/i.exec(trimmed);
  if (detailMatch?.[1]) {
    return normalizeModelReason(detailMatch[1].replace(/\\"/g, '"').trim(), modelId);
  }

  const messageMatch = /"message":"((?:\\"|[^"])*)"/i.exec(trimmed);
  if (messageMatch?.[1]) {
    const decodedMessage = messageMatch[1].replace(/\\"/g, '"');
    const nestedDetailMatch = /"detail":"([^"]+)"/i.exec(decodedMessage);
    if (nestedDetailMatch?.[1]) {
      return normalizeModelReason(nestedDetailMatch[1].trim(), modelId);
    }
    return normalizeModelReason(decodeQuotedJsonString(decodedMessage).trim(), modelId);
  }

  return trimmed;
}

export function getResultReason(
  modelId: string,
  result: TeamProvisioningPrepareResult
): string | null {
  const candidates = [...(result.details ?? []), ...(result.warnings ?? []), result.message]
    .map((entry) => entry?.trim() ?? '')
    .filter(Boolean);

  for (const candidate of candidates) {
    const stripped = stripSelectedModelPrefix(modelId, candidate);
    if (stripped) {
      return normalizeModelReason(stripped, modelId);
    }
  }

  return null;
}

export function getModelScopedEntries(
  modelId: string,
  result: TeamProvisioningPrepareResult
): string[] {
  const escapedModelId = escapeRegExp(modelId);
  const scopedPattern = new RegExp(`^Selected model ${escapedModelId}\\b`, 'i');
  return [...(result.details ?? []), ...(result.warnings ?? []), result.message]
    .map((entry) => entry?.trim() ?? '')
    .filter(Boolean)
    .filter((entry) => scopedPattern.test(entry));
}

export function isModelScopedEntryForAnyModel(modelIds: readonly string[], entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) {
    return false;
  }

  return modelIds.some((modelId) =>
    new RegExp(`^Selected model ${escapeRegExp(modelId)}\\b`, 'i').test(trimmed)
  );
}

export function looksLikeSingleModelBatchFailure(
  modelId: string,
  result: TeamProvisioningPrepareResult
): boolean {
  const candidates = [...(result.details ?? []), ...(result.warnings ?? []), result.message]
    .map((entry) => entry?.trim() ?? '')
    .filter(Boolean);
  const modelLower = modelId.toLowerCase();

  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
    return (
      lower.includes(modelLower) ||
      lower.includes('requested model') ||
      lower.includes('model is not supported') ||
      lower.includes('model is not available') ||
      lower.includes('selected model')
    );
  });
}

export function getScopedModelReason(modelId: string, entries: string[]): string | null {
  for (const entry of entries) {
    const stripped = stripSelectedModelPrefix(modelId, entry);
    if (!stripped) {
      continue;
    }
    const normalized = normalizeModelReason(stripped, modelId);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}
