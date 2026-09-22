import { capturePostHogEvent } from '@renderer/posthog';

type AnalyticsPrimitive = string | number | boolean | null;
type AnalyticsProperties = Record<string, AnalyticsPrimitive>;

export type AnalyticsProviderId =
  | 'amazon-bedrock'
  | 'anthropic'
  | 'azure'
  | 'cerebras'
  | 'codex'
  | 'cohere'
  | 'cursor-acp'
  | 'deepseek'
  | 'gemini'
  | 'github-copilot'
  | 'google'
  | 'google-vertex'
  | 'groq'
  | 'huggingface'
  | 'kiro'
  | 'kimi-for-coding'
  | 'minimax-coding-plan'
  | 'mistral'
  | 'nvidia'
  | 'ollama-cloud'
  | 'openai'
  | 'opencode'
  | 'openrouter'
  | 'other'
  | 'perplexity'
  | 'togetherai'
  | 'xai'
  | 'xiaomi-token-plan-ams'
  | 'xiaomi-token-plan-cn'
  | 'xiaomi-token-plan-sgp'
  | 'zai-coding-plan'
  | 'unknown';
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
export type AnalyticsBytesBucket =
  | '0'
  | '1_100kb'
  | '100kb_1mb'
  | '1_10mb'
  | '10mb_plus'
  | 'unknown';
export type AnalyticsLaunchStep =
  | 'config_validation'
  | 'runtime_prepare'
  | 'member_spawn'
  | 'bootstrap'
  | 'ready_check'
  | 'unknown';
export type AnalyticsFileTypeFamily =
  | 'image'
  | 'document'
  | 'archive'
  | 'audio'
  | 'video'
  | 'text'
  | 'code'
  | 'other'
  | 'unknown';
export type AnalyticsAttachmentSource = 'message' | 'task' | 'comment' | 'unknown';
export type AnalyticsTeamLifecycleSource = 'list' | 'detail' | 'relaunch' | 'store' | 'unknown';
export type AnalyticsOnboardingStep =
  | 'wizard_start'
  | 'wizard_restart'
  | 'runtime_prepare'
  | 'connect_start'
  | 'connection_submit'
  | 'verification_start'
  | 'model_accept'
  | 'credential_open'
  | 'unknown';
export type AnalyticsOnboardingStepOutcome = 'completed' | 'cancelled' | 'failed';
export type AnalyticsProviderReadinessState =
  | 'ready'
  | 'authentication_required'
  | 'configuration_required'
  | 'runtime_missing'
  | 'temporarily_unavailable'
  | 'error';
export type AnalyticsProviderCheckReason =
  | 'startup'
  | 'manual_refresh'
  | 'provider_setup'
  | 'provider_change'
  | 'runtime_install'
  | 'runtime_event'
  | 'launch_preflight'
  | 'unknown';
export type AnalyticsProviderConnectionIntent = 'connect' | 'reconnect' | 'unknown';
export type AnalyticsProviderConnectionOutcome =
  | 'verified'
  | 'connected_unverified'
  | 'cancelled'
  | 'failed';

const SAFE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'amazon-bedrock',
  'anthropic',
  'azure',
  'cerebras',
  'codex',
  'cohere',
  'cursor-acp',
  'deepseek',
  'gemini',
  'github-copilot',
  'google',
  'google-vertex',
  'groq',
  'huggingface',
  'kiro',
  'kimi-for-coding',
  'minimax-coding-plan',
  'mistral',
  'nvidia',
  'ollama-cloud',
  'openai',
  'opencode',
  'openrouter',
  'perplexity',
  'togetherai',
  'xai',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai-coding-plan',
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

export function bucketBytes(bytes: number | null | undefined): AnalyticsBytesBucket {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes === 0) return '0';
  if (bytes <= 100 * 1024) return '1_100kb';
  if (bytes <= 1024 * 1024) return '100kb_1mb';
  if (bytes <= 10 * 1024 * 1024) return '1_10mb';
  return '10mb_plus';
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
  if (!normalized) return 'unknown';
  return SAFE_PROVIDER_IDS.has(normalized) ? (normalized as AnalyticsProviderId) : 'other';
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
  if (!normalized) return 'not_detected';
  if (normalized.includes('api')) return 'api_key';
  if (normalized.includes('oauth')) return 'oauth';
  if (normalized.includes('claude') || normalized.includes('chatgpt')) return 'browser_session';
  if (normalized.includes('subscription')) return 'browser_session';
  if (normalized.includes('managed')) return 'managed';
  if (normalized.includes('wellknown') || normalized.includes('well_known')) return 'well_known';
  if (normalized === 'manual') return 'manual';
  return 'unknown';
}

export function classifyAnalyticsError(error: unknown): AnalyticsErrorClass {
  if (error == null) return 'none';
  const message = (() => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (typeof error !== 'object') return '';
    const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
    const detail = 'message' in error && typeof error.message === 'string' ? error.message : '';
    return `${code} ${detail}`.trim();
  })();
  const normalized = message.toLowerCase();
  if (!normalized) return 'unknown';
  if (
    normalized.includes('auth') ||
    normalized.includes('login') ||
    normalized.includes('token') ||
    normalized.includes('api key') ||
    normalized.includes('credential') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  ) {
    return 'auth';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout';
  if (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('econn') ||
    normalized.includes('offline') ||
    normalized.includes('unavailable')
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
  runtime: 'opencode';
  provider: string | null | undefined;
  authMethod: string | null;
  connectionIntent: AnalyticsProviderConnectionIntent;
  outcome: AnalyticsProviderConnectionOutcome;
  errorClass?: AnalyticsErrorClass;
  durationMs?: number | null;
}): void {
  captureProductEvent('provider_setup:connection_end', {
    event_schema_version: 2,
    runtime: input.runtime,
    provider: normalizeAnalyticsProviderId(input.provider),
    auth_method: normalizeAuthMethod(input.authMethod),
    connection_intent: input.connectionIntent,
    outcome: input.outcome,
    model_verified: input.outcome === 'verified',
    success: input.outcome === 'verified' || input.outcome === 'connected_unverified',
    error_class: input.errorClass ?? 'none',
    duration_ms_bucket: bucketDurationMs(input.durationMs),
  });
}

export function recordProviderReadinessStateObserved(input: {
  provider: string | null | undefined;
  readinessState: AnalyticsProviderReadinessState;
  previousReadinessState: AnalyticsProviderReadinessState | 'unknown';
  observationKind: 'initial' | 'changed' | 'unchanged';
  checkReason: AnalyticsProviderCheckReason;
  checkOutcome: 'completed' | 'failed';
  authenticated: boolean;
  authMethod: string | null;
  verificationState: 'verified' | 'unknown' | 'offline' | 'error';
  providerSupported: boolean;
  launchCapable: boolean;
  errorClass?: AnalyticsErrorClass;
  durationMs?: number | null;
}): void {
  captureProductEvent('provider_readiness:state_observed', {
    event_schema_version: 2,
    provider: normalizeAnalyticsProviderId(input.provider),
    readiness_state: input.readinessState,
    previous_readiness_state: input.previousReadinessState,
    observation_kind: input.observationKind,
    check_reason: input.checkReason,
    check_outcome: input.checkOutcome,
    authenticated: input.authenticated,
    auth_method: normalizeAuthMethod(input.authMethod),
    verification_state: input.verificationState,
    provider_supported: input.providerSupported,
    launch_capable: input.launchCapable,
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

export function recordTeamLaunchStepEnd(input: {
  step: AnalyticsLaunchStep;
  success: boolean;
  durationMs?: number | null;
  memberCount?: number | null;
  providerIds: readonly (string | null | undefined)[];
  errorClass?: AnalyticsErrorClass;
  partialFailure?: boolean;
}): void {
  const providerMix = buildProviderMix(input.providerIds);
  captureProductEvent('team_management:launch_step_end', {
    step: input.step,
    success: input.success,
    duration_ms_bucket: bucketDurationMs(input.durationMs),
    member_count_bucket: bucketCount(input.memberCount),
    provider_mix: providerMix.providerMix,
    error_class: input.errorClass ?? 'none',
    partial_failure: input.partialFailure ?? false,
  });
}

export function recordTeamStop(input: {
  source: AnalyticsTeamLifecycleSource;
  success: boolean;
  memberCount?: number | null;
  providerIds?: readonly (string | null | undefined)[];
  runtimeActive?: boolean | null;
  hadRunningTasks?: boolean | null;
  errorClass?: AnalyticsErrorClass;
}): void {
  recordTeamLifecycleEvent('team_management:team_stop', input);
}

export function recordTeamDelete(input: {
  source: AnalyticsTeamLifecycleSource;
  success: boolean;
  memberCount?: number | null;
  providerIds?: readonly (string | null | undefined)[];
  runtimeActive?: boolean | null;
  hadRunningTasks?: boolean | null;
  errorClass?: AnalyticsErrorClass;
}): void {
  recordTeamLifecycleEvent('team_management:team_delete', input);
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

export function recordTaskFirstOutput(input: {
  targetType: 'member' | 'team' | 'unknown';
  durationMs?: number | null;
  provider?: string | null;
  teamSize?: number | null;
  hasAttachments: boolean;
  hasTaskRefs: boolean;
}): void {
  captureProductEvent('task_management:first_output', {
    target_type: input.targetType,
    duration_ms_bucket: bucketDurationMs(input.durationMs),
    provider: normalizeAnalyticsProviderId(input.provider),
    team_size_bucket: bucketCount(input.teamSize),
    has_attachments: input.hasAttachments,
    has_task_refs: input.hasTaskRefs,
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

export function recordAttachmentAttachEnd(input: {
  source: AnalyticsAttachmentSource;
  success: boolean;
  fileCount?: number | null;
  totalSizeBytes?: number | null;
  mimeTypes?: readonly (string | null | undefined)[];
  errorClass?: AnalyticsErrorClass;
}): void {
  captureProductEvent('attachment_management:attach_end', {
    source: input.source,
    success: input.success,
    file_count_bucket: bucketCount(input.fileCount),
    size_bucket: bucketBytes(input.totalSizeBytes),
    file_type_family: buildFileTypeFamilyMix(input.mimeTypes ?? []),
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

export function recordReviewApplyEnd(input: {
  success: boolean;
  decision: 'approve' | 'request_changes' | 'mixed' | 'single_file' | 'unknown';
  filesCount?: number | null;
  acceptedCount?: number | null;
  rejectedCount?: number | null;
  durationMs?: number | null;
  errorClass?: AnalyticsErrorClass;
}): void {
  captureProductEvent('change_review:apply_end', {
    success: input.success,
    decision: input.decision,
    files_count_bucket: bucketCount(input.filesCount),
    accepted_count_bucket: bucketCount(input.acceptedCount),
    rejected_count_bucket: bucketCount(input.rejectedCount),
    duration_ms_bucket: bucketDurationMs(input.durationMs),
    error_class: input.errorClass ?? 'none',
  });
}

export function recordProviderOnboardingStepEnd(input: {
  provider: string | null | undefined;
  step: AnalyticsOnboardingStep;
  outcome: AnalyticsOnboardingStepOutcome;
  durationMs?: number | null;
  errorClass?: AnalyticsErrorClass;
}): void {
  captureProductEvent('provider_setup:onboarding_step_end', {
    event_schema_version: 2,
    provider: normalizeAnalyticsProviderId(input.provider),
    step: input.step,
    outcome: input.outcome,
    success: input.outcome === 'completed',
    duration_ms_bucket: bucketDurationMs(input.durationMs),
    error_class: input.errorClass ?? 'none',
  });
}

export function recordCrossTeamMessageSend(input: {
  source: 'user' | 'runtime' | 'unknown';
  success: boolean;
  hasReplyTo: boolean;
  conversationDepth?: number | null;
  hasTaskRefs: boolean;
  errorClass?: AnalyticsErrorClass;
}): void {
  captureProductEvent('cross_team:message_send', {
    source: input.source,
    success: input.success,
    has_reply_to: input.hasReplyTo,
    conversation_depth_bucket: bucketCount(input.conversationDepth),
    has_task_refs: input.hasTaskRefs,
    error_class: input.errorClass ?? 'none',
  });
}

function normalizeRuntimeSource(source: string | null | undefined): string {
  const normalized = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (normalized === 'app-managed' || normalized === 'path' || normalized === 'missing') {
    return normalized;
  }
  return 'unknown';
}

function recordTeamLifecycleEvent(
  eventName: 'team_management:team_stop' | 'team_management:team_delete',
  input: {
    source: AnalyticsTeamLifecycleSource;
    success: boolean;
    memberCount?: number | null;
    providerIds?: readonly (string | null | undefined)[];
    runtimeActive?: boolean | null;
    hadRunningTasks?: boolean | null;
    errorClass?: AnalyticsErrorClass;
  }
): void {
  const providerMix = buildProviderMix(input.providerIds ?? []);
  captureProductEvent(eventName, {
    source: input.source,
    success: input.success,
    member_count_bucket: bucketCount(input.memberCount),
    provider_mix: providerMix.providerMix,
    runtime_active: input.runtimeActive ?? null,
    had_running_tasks: input.hadRunningTasks ?? null,
    error_class: input.errorClass ?? 'none',
  });
}

function buildFileTypeFamilyMix(
  mimeTypes: readonly (string | null | undefined)[]
): AnalyticsFileTypeFamily | 'mixed' {
  const families = [...new Set(mimeTypes.map(normalizeFileTypeFamily))].sort();
  if (families.length === 0) return 'unknown';
  if (families.length === 1) return families[0] ?? 'unknown';
  return 'mixed';
}

function normalizeFileTypeFamily(mimeType: string | null | undefined): AnalyticsFileTypeFamily {
  const normalized = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (!normalized) return 'unknown';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('text/')) return normalized.includes('html') ? 'code' : 'text';
  if (
    normalized.includes('javascript') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('yaml') ||
    normalized.includes('typescript')
  ) {
    return 'code';
  }
  if (
    normalized.includes('pdf') ||
    normalized.includes('document') ||
    normalized.includes('spreadsheet') ||
    normalized.includes('presentation')
  ) {
    return 'document';
  }
  if (
    normalized.includes('zip') ||
    normalized.includes('tar') ||
    normalized.includes('gzip') ||
    normalized.includes('compressed')
  ) {
    return 'archive';
  }
  return 'other';
}
