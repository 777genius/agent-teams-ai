import type { CodexMetadataSnapshot } from '@agent-teams/legacy-agent-host/management/contracts';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

export type CapturedCodexMetadata = CodexMetadataSnapshot;
export type CaptureCodexMetadata = (
  projectPath: string | null
) => Promise<CapturedProviderManagement>;
const invalid = (): never => {
  throw new Error('Captured Codex metadata is unavailable.');
};
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 2048): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
  );
}
const nullable = (value: unknown) => value === null || text(value);
function model(value: unknown): void {
  const row = object(value, [
    'id',
    'model',
    'displayName',
    'description',
    'hidden',
    'isDefault',
    'supportedReasoningEfforts',
    'defaultReasoningEffort',
    'inputModalities',
    'supportsPersonality',
  ]);
  if (
    ![row.id, row.model, row.displayName].every((entry) => text(entry)) ||
    !(
      row.description === null ||
      (typeof row.description === 'string' && row.description.length <= 8192)
    ) ||
    ![row.hidden, row.isDefault, row.supportsPersonality].every(
      (entry) => typeof entry === 'boolean'
    ) ||
    !nullable(row.defaultReasoningEffort)
  )
    return invalid();
  for (const [items, limit] of [
    [row.supportedReasoningEfforts, 32],
    [row.inputModalities, 16],
  ] as const) {
    if (!Array.isArray(items) || items.length > limit || !items.every((entry) => text(entry)))
      return invalid();
  }
}
function decode(raw: unknown): CapturedCodexMetadata {
  const reply = object(raw, ['ok', 'value', 'code']);
  if (reply.ok !== true) return invalid();
  const value = object(reply.value, [
    'profileId',
    'configRevision',
    'account',
    'requiresOpenaiAuth',
    'configuration',
    'models',
    'rateLimits',
  ]);
  if (
    !text(value.profileId, 256) ||
    !text(value.configRevision, 256) ||
    typeof value.requiresOpenaiAuth !== 'boolean'
  )
    return invalid();
  if (value.account !== null) {
    const account = object(value.account, ['type', 'email', 'planType']);
    if (account.type === 'apiKey') {
      if (Object.keys(account).length !== 1) return invalid();
    } else if (
      account.type !== 'chatgpt' ||
      !text(account.email, 1024) ||
      !text(account.planType, 128)
    )
      return invalid();
  }
  const config = object(value.configuration, ['model', 'modelProvider', 'reasoningEffort']);
  if (
    ![config.model, config.modelProvider, config.reasoningEffort].every(nullable) ||
    !Array.isArray(value.models) ||
    value.models.length > 500
  )
    return invalid();
  for (const row of value.models) model(row);
  if (value.rateLimits !== undefined) {
    const quotas = object(value.rateLimits, ['state', 'snapshot']);
    if (
      !['ready', 'not-requested', 'not-authenticated', 'unavailable'].includes(String(quotas.state))
    )
      return invalid();
    if (quotas.state !== 'ready') {
      if (quotas.snapshot !== null) return invalid();
    } else validateQuota(quotas.snapshot);
  }
  // All required fields, finite counts and primitive types have been validated above.
  return value as unknown as CapturedCodexMetadata;
}

function validateQuota(raw: unknown): void {
  const value = object(raw, [
    'limitId',
    'limitName',
    'primary',
    'secondary',
    'credits',
    'planType',
  ]);
  for (const key of ['limitId', 'limitName', 'planType'])
    if (
      !(
        value[key] === null ||
        (typeof value[key] === 'string' && String(value[key]).length <= 1024)
      )
    )
      return invalid();
  for (const key of ['primary', 'secondary']) {
    if (value[key] === null) continue;
    const row = object(value[key], ['usedPercent', 'windowDurationMins', 'resetsAt']);
    if (
      typeof row.usedPercent !== 'number' ||
      !Number.isFinite(row.usedPercent) ||
      row.usedPercent < 0 ||
      row.usedPercent > 1000000
    )
      return invalid();
    for (const field of ['windowDurationMins', 'resetsAt'])
      if (row[field] !== null && (!Number.isSafeInteger(row[field]) || Number(row[field]) < 0))
        return invalid();
  }
  if (value.credits !== null) {
    const credits = object(value.credits, ['hasCredits', 'unlimited', 'balance']);
    if (
      typeof credits.hasCredits !== 'boolean' ||
      typeof credits.unlimited !== 'boolean' ||
      !(
        credits.balance === null ||
        (typeof credits.balance === 'string' && credits.balance.length <= 1024)
      )
    )
      return invalid();
  }
}

/** A response can be used only by its original foreground account/config selection. */
export async function readCapturedCodexMetadata(
  capture: CaptureCodexMetadata,
  projectPath: string | null,
  includeModels: boolean,
  includeRateLimits = false
) {
  const target = await capture(projectPath);
  const value = decode(
    await target.request('codex.metadata', {
      includeModels,
      ...(includeRateLimits ? { includeRateLimits: true } : {}),
    })
  );
  if (
    !target.isCurrent() ||
    value.profileId !== target.profileId ||
    value.configRevision !== target.configRevision ||
    new Set(value.models.map((entry) => entry.id)).size !== value.models.length
  )
    return invalid();
  return { target, value };
}
