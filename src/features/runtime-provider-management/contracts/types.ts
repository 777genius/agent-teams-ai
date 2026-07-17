export type RuntimeProviderManagementRuntimeId = 'opencode';

export const RUNTIME_PROVIDER_COMPANION_IDS = ['kiro-cli', 'cursor-agent'] as const;

export type RuntimeProviderCompanionIdDto = (typeof RUNTIME_PROVIDER_COMPANION_IDS)[number];

const RUNTIME_PROVIDER_COMPANION_ID_SET = new Set<string>(RUNTIME_PROVIDER_COMPANION_IDS);

export function isRuntimeProviderCompanionId(
  value: unknown
): value is RuntimeProviderCompanionIdDto {
  return typeof value === 'string' && RUNTIME_PROVIDER_COMPANION_ID_SET.has(value);
}

export type RuntimeProviderCompanionPhaseDto =
  | 'checking'
  | 'missing'
  | 'downloading'
  | 'installing'
  | 'verifying-install'
  | 'sign-in-required'
  | 'signing-in'
  | 'verifying-auth'
  | 'verifying-model'
  | 'connected'
  | 'needs-manual-step'
  | 'error';

export interface RuntimeProviderCompanionStatusDto {
  companionId: RuntimeProviderCompanionIdDto;
  displayName: string;
  phase: RuntimeProviderCompanionPhaseDto;
  installed: boolean;
  authenticated: boolean;
  binaryPath: string | null;
  version: string | null;
  percent: number | null;
  message: string;
  detail: string | null;
  error: string | null;
  manualCommand: string;
  manualUrl: string;
  updatedAt: string;
}

export interface RuntimeProviderCompanionInput {
  companionId: RuntimeProviderCompanionIdDto;
  projectPath?: string | null;
}

export type RuntimeProviderStateDto = 'ready' | 'needs-auth' | 'needs-setup' | 'degraded';

export type RuntimeProviderManagedProfileStateDto = 'active' | 'missing' | 'stale';

export type RuntimeProviderLocalAuthStateDto = 'synced' | 'missing' | 'stale' | 'disabled';

export type RuntimeProviderConnectionStateDto =
  | 'connected'
  | 'available'
  | 'not-connected'
  | 'ignored'
  | 'error';

export type RuntimeProviderOwnershipDto = 'managed' | 'local' | 'env' | 'project';

export type RuntimeProviderAuthMethodDto = 'api' | 'oauth' | 'wellknown';

export type RuntimeProviderSetupMethodDto = 'api' | 'oauth' | 'manual';

export type RuntimeProviderSetupPromptTypeDto = 'text' | 'select';

export interface RuntimeProviderSetupPromptOptionDto {
  label: string;
  value: string;
  hint: string | null;
}

export interface RuntimeProviderSetupPromptConditionDto {
  key: string;
  op: string;
  value: string;
}

export interface RuntimeProviderSetupPromptDto {
  key: string;
  type: RuntimeProviderSetupPromptTypeDto;
  label: string;
  placeholder: string | null;
  required: boolean;
  secret: boolean;
  options: readonly RuntimeProviderSetupPromptOptionDto[];
  when: RuntimeProviderSetupPromptConditionDto | null;
}

export interface RuntimeProviderSetupAuthOptionDto {
  id: string;
  method: Exclude<RuntimeProviderSetupMethodDto, 'manual'>;
  methodIndex: number | null;
  label: string;
  supported: boolean;
  disabledReason: string | null;
  secret: RuntimeProviderSetupFormDto['secret'];
  prompts: readonly RuntimeProviderSetupPromptDto[];
}

export type RuntimeProviderSetupFormSourceDto = 'opencode-auth' | 'curated' | 'oauth' | 'manual';

export interface RuntimeProviderSetupFormDto {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  displayName: string;
  method: RuntimeProviderSetupMethodDto;
  supported: boolean;
  title: string;
  description: string | null;
  submitLabel: string;
  disabledReason: string | null;
  source: RuntimeProviderSetupFormSourceDto;
  secret: {
    key: 'key';
    label: string;
    placeholder: string | null;
    required: boolean;
  } | null;
  prompts: readonly RuntimeProviderSetupPromptDto[];
  /** Optional while older packaged orchestrators are still supported. */
  authOptions?: readonly RuntimeProviderSetupAuthOptionDto[];
  /** Optional while older packaged orchestrators are still supported. */
  defaultAuthOptionId?: string | null;
  /** Optional while older packaged orchestrators are still supported. */
  verification?: {
    kind: 'model-request';
    freeModelPreferred: boolean;
    mayUseQuotaOrBalance: boolean;
  } | null;
}

export type RuntimeProviderOAuthCompletionMethodDto = 'auto' | 'code';

export type RuntimeProviderOAuthProgressPhaseDto =
  | 'authorizing'
  | 'waiting-for-browser'
  | 'waiting-for-code'
  | 'completing'
  | 'cancelled'
  | 'failed';

export interface RuntimeProviderOAuthProgressDto {
  operationId: string;
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  displayName: string;
  authOptionId: string;
  methodIndex: number;
  phase: RuntimeProviderOAuthProgressPhaseDto;
  completionMethod: RuntimeProviderOAuthCompletionMethodDto | null;
  instructions: string | null;
  message: string | null;
}

export type RuntimeProviderActionIdDto =
  | 'connect'
  | 'reconnect'
  | 'use'
  | 'test'
  | 'set-default'
  | 'forget'
  | 'configure'
  | 'unignore';

export type RuntimeProviderActionOwnershipScopeDto = RuntimeProviderOwnershipDto | 'runtime';

export interface RuntimeProviderActionDescriptorDto {
  id: RuntimeProviderActionIdDto;
  label: string;
  enabled: boolean;
  disabledReason: string | null;
  requiresSecret: boolean;
  ownershipScope: RuntimeProviderActionOwnershipScopeDto;
}

export interface RuntimeProviderManagementRuntimeDto {
  state: RuntimeProviderStateDto;
  cliPath: string | null;
  version: string | null;
  managedProfile: RuntimeProviderManagedProfileStateDto;
  localAuth: RuntimeProviderLocalAuthStateDto;
}

export interface RuntimeProviderConnectionDto {
  providerId: string;
  displayName: string;
  state: RuntimeProviderConnectionStateDto;
  ownership: readonly RuntimeProviderOwnershipDto[];
  recommended: boolean;
  modelCount: number;
  defaultModelId: string | null;
  authMethods: readonly RuntimeProviderAuthMethodDto[];
  actions: readonly RuntimeProviderActionDescriptorDto[];
  detail: string | null;
  connectedAuthHint?: RuntimeProviderAuthMethodDto | null;
  verifiedModelId?: string | null;
}

export type RuntimeProviderDirectoryFilterDto =
  | 'all'
  | 'connected'
  | 'configured'
  | 'connectable'
  | 'manual'
  | 'has-models';

export type RuntimeProviderSetupKindDto =
  | 'connected'
  | 'connect-oauth'
  | 'connect-api-key'
  | 'configure-manually'
  | 'requires-environment'
  | 'available-readonly'
  | 'unsupported';

export type RuntimeProviderDirectorySourceDto =
  | 'opencode-provider'
  | 'config-provider'
  | 'inventory'
  | 'seed';

export interface RuntimeProviderDirectoryEntryDto {
  providerId: string;
  displayName: string;
  state: RuntimeProviderConnectionStateDto;
  /** Actual saved credential type when reported by the OpenCode inventory. */
  connectedAuthHint?: string | null;
  setupKind: RuntimeProviderSetupKindDto;
  ownership: readonly RuntimeProviderOwnershipDto[];
  recommended: boolean;
  modelCount: number | null;
  authMethods: readonly RuntimeProviderAuthMethodDto[];
  defaultModelId: string | null;
  sources: readonly RuntimeProviderDirectorySourceDto[];
  sourceLabel: string | null;
  providerSource: string | null;
  detail: string | null;
  actions: readonly RuntimeProviderActionDescriptorDto[];
  metadata: {
    hasKnownModels: boolean;
    requiresManualConfig: boolean;
    supportedInlineAuth: boolean;
    configuredAuthless: boolean;
  };
}

export interface RuntimeProviderDirectoryDto {
  runtimeId: RuntimeProviderManagementRuntimeId;
  totalCount: number;
  returnedCount: number;
  query: string | null;
  filter: RuntimeProviderDirectoryFilterDto;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  entries: readonly RuntimeProviderDirectoryEntryDto[];
  diagnostics: readonly string[];
  fetchedAt: string;
}

export interface RuntimeProviderManagementViewDto {
  runtimeId: RuntimeProviderManagementRuntimeId;
  title: string;
  runtime: RuntimeProviderManagementRuntimeDto;
  providers: readonly RuntimeProviderConnectionDto[];
  configuredModels?: readonly RuntimeProviderModelDto[];
  projectPath?: string | null;
  projectDefaultModel?: string | null;
  allProjectsDefaultModel?: string | null;
  defaultModelSource?: RuntimeProviderDefaultModelSourceDto | null;
  defaultModel: string | null;
  fallbackModel: string | null;
  diagnostics: readonly string[];
}

export type RuntimeProviderDefaultModelSourceDto =
  | 'project'
  | 'all_projects'
  | 'opencode_config'
  | 'fallback';

export type RuntimeProviderDefaultScopeDto = 'project' | 'all_projects';

export type RuntimeProviderManagementErrorCodeDto =
  | 'unsupported-runtime'
  | 'unsupported-action'
  | 'runtime-missing'
  | 'runtime-misconfigured'
  | 'runtime-unhealthy'
  | 'provider-missing'
  | 'auth-required'
  | 'auth-failed'
  | 'model-missing'
  | 'model-test-failed'
  | 'unsupported-auth-method';

export interface RuntimeProviderManagementErrorDiagnosticsDto {
  errorCode?: RuntimeProviderManagementErrorCodeDto | null;
  summary: string | null;
  likelyCause: string | null;
  binaryPath: string | null;
  command: string | null;
  projectPath: string | null;
  exitCode: number | null;
  stderrPreview: string | null;
  stdoutPreview: string | null;
  hints: readonly string[];
}

export interface RuntimeProviderManagementErrorDto {
  code: RuntimeProviderManagementErrorCodeDto;
  message: string;
  recoverable: boolean;
  diagnostics?: RuntimeProviderManagementErrorDiagnosticsDto | null;
}

export interface RuntimeProviderManagementViewResponse {
  schemaVersion: 1;
  runtimeId: RuntimeProviderManagementRuntimeId;
  view?: RuntimeProviderManagementViewDto;
  error?: RuntimeProviderManagementErrorDto;
}

export interface RuntimeProviderManagementDirectoryResponse {
  schemaVersion: 1;
  runtimeId: RuntimeProviderManagementRuntimeId;
  directory?: RuntimeProviderDirectoryDto;
  error?: RuntimeProviderManagementErrorDto;
}

export interface RuntimeProviderManagementProviderResponse {
  schemaVersion: 1;
  runtimeId: RuntimeProviderManagementRuntimeId;
  provider?: RuntimeProviderConnectionDto;
  error?: RuntimeProviderManagementErrorDto;
}

export interface RuntimeProviderManagementSetupFormResponse {
  schemaVersion: 1;
  runtimeId: RuntimeProviderManagementRuntimeId;
  setupForm?: RuntimeProviderSetupFormDto;
  error?: RuntimeProviderManagementErrorDto;
}

export type RuntimeProviderModelAvailabilityDto =
  | 'available'
  | 'unavailable'
  | 'not-authenticated'
  | 'unknown'
  | 'untested';

export type RuntimeProviderModelAccessKindDto =
  | 'no_model'
  | 'unknown_model'
  | 'credentialed'
  | 'builtin_free'
  | 'configured_authless'
  | 'verified'
  | 'not_authenticated'
  | 'execution_failed';

export type RuntimeProviderModelRouteKindDto =
  | 'connected_provider'
  | 'builtin_free'
  | 'configured_local'
  | 'catalog_provider';

export type RuntimeProviderModelProofStateDto =
  | 'not_required'
  | 'needs_probe'
  | 'verified'
  | 'failed';

export type RuntimeProviderModelCatalogStatusDto = 'active' | 'alpha' | 'beta' | 'deprecated';

export interface RuntimeProviderModelDto {
  modelId: string;
  providerId: string;
  displayName: string;
  sourceLabel: string;
  free: boolean;
  default: boolean;
  /** Optional while older packaged orchestrators are still supported. */
  catalogStatus?: RuntimeProviderModelCatalogStatusDto;
  availability: RuntimeProviderModelAvailabilityDto;
  accessKind?: RuntimeProviderModelAccessKindDto;
  routeKind?: RuntimeProviderModelRouteKindDto;
  proofState?: RuntimeProviderModelProofStateDto;
  requiresExecutionProof?: boolean;
  accessReason?: string | null;
  catalogContextTokens?: number | null;
  catalogOutputTokens?: number | null;
  managedContextTokens?: number | null;
  managedOutputTokens?: number | null;
  managedUpdatedAt?: string | null;
}

export interface RuntimeProviderManagementModelsDto {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  models: readonly RuntimeProviderModelDto[];
  defaultModelId: string | null;
  diagnostics: readonly string[];
  totalCount?: number;
  returnedCount?: number;
  limit?: number | null;
  cursor?: string | null;
  nextCursor?: string | null;
}

export interface RuntimeProviderManagementModelsResponse {
  schemaVersion: 1;
  runtimeId: RuntimeProviderManagementRuntimeId;
  models?: RuntimeProviderManagementModelsDto;
  error?: RuntimeProviderManagementErrorDto;
}

export interface RuntimeProviderModelTestResultDto {
  providerId: string;
  modelId: string;
  ok: boolean;
  availability: RuntimeProviderModelAvailabilityDto;
  message: string;
  diagnostics: readonly string[];
}

export interface RuntimeProviderManagementModelTestResponse {
  schemaVersion: 1;
  runtimeId: RuntimeProviderManagementRuntimeId;
  result?: RuntimeProviderModelTestResultDto;
  error?: RuntimeProviderManagementErrorDto;
}

export interface RuntimeProviderManagementLoadViewInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  projectPath?: string | null;
}

export interface RuntimeProviderManagementLoadDirectoryInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  summary?: boolean | null;
  projectPath?: string | null;
  query?: string | null;
  filter?: RuntimeProviderDirectoryFilterDto | null;
  limit?: number | null;
  cursor?: string | null;
  refresh?: boolean | null;
}

export interface RuntimeProviderManagementConnectApiKeyInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  apiKey: string;
  projectPath?: string | null;
}

export interface RuntimeProviderManagementLoadSetupFormInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  projectPath?: string | null;
}

export interface RuntimeProviderManagementConnectInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  method: RuntimeProviderSetupMethodDto;
  apiKey?: string | null;
  metadata?: Record<string, string> | null;
  authMethodIndex?: number | null;
  authOptionId?: string | null;
  oauthOperationId?: string | null;
  projectPath?: string | null;
}

export interface RuntimeProviderManagementSubmitOAuthCodeInput {
  operationId: string;
  code: string;
}

export interface RuntimeProviderManagementCancelOAuthInput {
  operationId: string;
}

export interface RuntimeProviderManagementOAuthControlResponse {
  ok: boolean;
  error?: string;
}

export interface RuntimeProviderManagementForgetInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  projectPath?: string | null;
}

export interface RuntimeProviderManagementLoadModelsInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  projectPath?: string | null;
  query?: string | null;
  limit?: number | null;
  cursor?: string | null;
  /** App-local cancellation group. It is not forwarded to the runtime CLI. */
  requestGroupId?: string | null;
}

export interface RuntimeProviderManagementTestModelInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  modelId: string;
  projectPath?: string | null;
}

export interface RuntimeProviderManagementSetDefaultModelInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  modelId: string;
  probe?: boolean;
  scope?: RuntimeProviderDefaultScopeDto;
  projectPath?: string | null;
}

export interface RuntimeProviderManagementConfigureModelLimitsInput {
  runtimeId: RuntimeProviderManagementRuntimeId;
  providerId: string;
  modelId: string;
  contextTokens: number;
  outputTokens: number;
  projectPath?: string | null;
}

export interface RuntimeProviderModelLimitsResultDto {
  providerId: string;
  modelId: string;
  contextTokens: number;
  outputTokens: number;
  saved: boolean;
  verified: boolean;
  message: string;
  diagnostics: readonly string[];
}

export interface RuntimeProviderManagementModelLimitsResponse {
  schemaVersion: 1;
  runtimeId: RuntimeProviderManagementRuntimeId;
  result?: RuntimeProviderModelLimitsResultDto;
  error?: RuntimeProviderManagementErrorDto;
}
