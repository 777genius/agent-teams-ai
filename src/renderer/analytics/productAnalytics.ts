import { capturePostHogEvent } from '@renderer/posthog';

type AnalyticsPrimitive = string | number | boolean | null;
type AnalyticsProperties = Record<string, AnalyticsPrimitive>;

export type AnalyticsProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode' | 'unknown';
export type AnalyticsErrorClass =
  | 'none'
  | 'auth'
  | 'network'
  | 'runtime_missing'
  | 'timeout'
  | 'validation'
  | 'permission'
  | 'unknown';
export type AnalyticsCountBucket = '0' | '1' | '2_5' | '6_10' | '11_25' | '26_plus' | 'unknown';
export type AnalyticsDurationBucket =
  | 'lt_1s'
  | '1_5s'
  | '5_15s'
  | '15_60s'
  | '1_5m'
  | '5m_plus'
  | 'unknown';
export type AnalyticsPromptLengthBucket = '0' | '1_200' | '201_1000' | '1001_4000' | '4001_plus';

const SAFE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'anthropic',
  'codex',
  'gemini',
  'opencode',
]);

function captureProductEvent(eventName: string, properties: AnalyticsProperties): void {
  capturePostHogEvent(eventName, properties);
}

export function bucketCount(count: number | null | undefined): AnalyticsCountBucket {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return 'unknown';
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 10) return '6_10';
  if (count <= 25) return '11_25';
  return '26_plus';
}

export function bucketDurationMs(durationMs: number | null | undefined): AnalyticsDurationBucket {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return 'unknown';
  }
  if (durationMs < 1_000) return 'lt_1s';
  if (durationMs < 5_000) return '1_5s';
  if (durationMs < 15_000) return '5_15s';
  if (durationMs < 60_000) return '15_60s';
  if (durationMs < 300_000) return '1_5m';
  return '5m_plus';
}

export function bucketPromptLength(length: number | null | undefined): AnalyticsPromptLengthBucket {
  if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0) return '0';
  if (length <= 200) return '1_200';
  if (length <= 1_000) return '201_1000';
  if (length <= 4_000) return '1001_4000';
  return '4001_plus';
}

export function elapsedMsSince(startedAtMs: number): number | null {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  return Math.max(0, Date.now() - startedAtMs);
}

export function elapsedMsBetweenIso(
  startedAt: string | undefined,
  endedAt: string | undefined
): number | null {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const endedAtMs = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    return null;
  }
  return endedAtMs - startedAtMs;
}

export function normalizeAnalyticsProviderId(
  providerId: string | null | undefined
): AnalyticsProviderId {
  const normalized = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  return SAFE_PROVIDER_IDS.has(normalized) ? (normalized as AnalyticsProviderId) : 'unknown';
}

export function buildProviderMix(providerIds: readonly (string | null | undefined)[]): {
  providerMix: string;
  hasMixedProviders: boolean;
} {
  const providers = [...new Set(providerIds.map(normalizeAnalyticsProviderId))]
    .filter((providerId) => providerId !== 'unknown')
    .sort();
  if (providers.length === 0) {
    return { providerMix: 'unknown', hasMixedProviders: false };
  }
  return {
    providerMix: providers.join('+'),
    hasMixedProviders: providers.length > 1,
  };
}

export function normalizeAuthMethod(authMethod: string | null | undefined): string {
  const normalized = typeof authMethod === 'string' ? authMethod.trim().toLowerCase() : '';
  if (!normalized) return 'none';
  if (normalized.includes('api')) return 'api_key';
  if (normalized.includes('oauth')) return 'oauth';
  if (normalized.includes('claude') || normalized.includes('chatgpt')) return 'browser_session';
  if (normalized.includes('subscription')) return 'browser_session';
  return 'unknown';
}

export function classifyAnalyticsError(error: unknown): AnalyticsErrorClass {
  if (error == null) return 'none';
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? error.message
          : '';
  const normalized = message.toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('auth') || normalized.includes('login') || normalized.includes('token')) {
    return 'auth';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout';
  if (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('econn') ||
    normalized.includes('offline')
  ) {
    return 'network';
  }
  if (
    normalized.includes('runtime') ||
    normalized.includes('not installed') ||
    normalized.includes('not found') ||
    normalized.includes('missing')
  ) {
    return 'runtime_missing';
  }
  if (
    normalized.includes('permission') ||
    normalized.includes('eacces') ||
    normalized.includes('access denied')
  ) {
    return 'permission';
  }
  if (
    normalized.includes('invalid') ||
    normalized.includes('validation') ||
    normalized.includes('required')
  ) {
    return 'validation';
  }
  return 'unknown';
}

export function recordProviderConnectionEnd(input: {
  provider: string | null | undefined;
  authMethod?: string | null;
  success: boolean;
  errorClass?: AnalyticsErrorClass;
  durationMs?: number | null;
}): void {
  captureProductEvent('provider_setup:connection_end', {
    provider: normalizeAnalyticsProviderId(input.provider),
    auth_method: normalizeAuthMethod(input.authMethod),
    success: input.success,
    error_class: input.errorClass ?? 'none',
    duration_ms_bucket: bucketDurationMs(input.durationMs),
  });
}

export function recordRuntimeInstallEnd(input: {
  runtime: 'codex' | 'opencode';
  success: boolean;
  source?: string | null;
  errorClass?: AnalyticsErrorClass;
  durationMs?: number | null;
}): void {
  captureProductEvent('runtime_setup:install_end', {
    runtime: input.runtime,
    success: input.success,
    source: normalizeRuntimeSource(input.source),
    error_class: input.errorClass ?? 'none',
    duration_ms_bucket: bucketDurationMs(input.durationMs),
  });
}

export function recordTeamCreate(input: {
  source: 'dialog' | 'unknown';
  memberCount: number;
  providerIds: readonly (string | null | undefined)[];
  multimodelEnabled: boolean;
}): void {
  const providerMix = buildProviderMix(input.providerIds);
  captureProductEvent('team_management:team_create', {
    source: input.source,
    member_count: input.memberCount,
    member_count_bucket: bucketCount(input.memberCount),
    provider_mix: providerMix.providerMix,
    has_mixed_providers: providerMix.hasMixedProviders,
    multimodel_enabled: input.multimodelEnabled,
  });
}

export function recordTeamLaunchEnd(input: {
  success: boolean;
  durationMs?: number | null;
  memberCount?: number | null;
  providerIds: readonly (string | null | undefined)[];
  failureReasonClass?: AnalyticsErrorClass;
  partialFailure: boolean;
}): void {
  const providerMix = buildProviderMix(input.providerIds);
  captureProductEvent('team_management:launch_end', {
    success: input.success,
    duration_ms_bucket: bucketDurationMs(input.durationMs),
    member_count_bucket: bucketCount(input.memberCount),
    provider_mix: providerMix.providerMix,
    failure_reason_class: input.failureReasonClass ?? 'none',
    partial_failure: input.partialFailure,
  });
}

export function recordTaskCreate(input: {
  source: 'dialog' | 'unknown';
  targetType: 'member' | 'team';
  hasAttachments: boolean;
  hasTaskRefs: boolean;
  promptLength?: number | null;
  teamSize?: number | null;
}): void {
  captureProductEvent('task_management:task_create', {
    source: input.source,
    target_type: input.targetType,
    has_attachments: input.hasAttachments,
    has_task_refs: input.hasTaskRefs,
    prompt_length_bucket: bucketPromptLength(input.promptLength),
    team_size_bucket: bucketCount(input.teamSize),
  });
}

export function recordTaskEnd(input: {
  result: 'completed' | 'failed' | 'cancelled' | 'unknown';
  durationMs?: number | null;
  provider?: string | null;
  changedFilesCount?: number | null;
  reviewRequired: boolean;
  errorClass?: AnalyticsErrorClass;
}): void {
  captureProductEvent('task_management:task_end', {
    result: input.result,
    duration_ms_bucket: bucketDurationMs(input.durationMs),
    provider: normalizeAnalyticsProviderId(input.provider),
    changed_files_count_bucket: bucketCount(input.changedFilesCount),
    review_required: input.reviewRequired,
    error_class: input.errorClass ?? 'none',
  });
}

export function recordReviewSubmit(input: {
  decision: 'approve' | 'request_changes' | 'mixed';
  filesCount: number;
  acceptedCount: number;
  rejectedCount: number;
  requestChangesCount: number;
}): void {
  captureProductEvent('change_review:review_submit', {
    decision: input.decision,
    files_count_bucket: bucketCount(input.filesCount),
    accepted_count_bucket: bucketCount(input.acceptedCount),
    rejected_count_bucket: bucketCount(input.rejectedCount),
    request_changes_count_bucket: bucketCount(input.requestChangesCount),
  });
}

function normalizeRuntimeSource(source: string | null | undefined): string {
  const normalized = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (normalized === 'app-managed' || normalized === 'path' || normalized === 'missing') {
    return normalized;
  }
  return 'unknown';
}
