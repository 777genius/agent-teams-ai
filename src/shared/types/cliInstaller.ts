/**
 * CLI Installer types — shared between main, preload, and renderer processes.
 *
 * Used for detecting, downloading, verifying, and installing Claude Code CLI binary.
 */

import type {
  CodexAccountAppServerState,
  CodexAccountAuthMode,
  CodexAccountEffectiveAuthMode,
  CodexLaunchReadinessState,
  CodexLoginStateDto,
  CodexManagedAccountDto,
  CodexRateLimitSnapshotDto,
} from '@features/codex-account/contracts';

// =============================================================================
// Platform Detection
// =============================================================================

/**
 * Supported platform/architecture combinations for Claude CLI binary distribution.
 */
export type CliPlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'linux-arm64-musl'
  | 'linux-x64-musl'
  | 'win32-x64'
  | 'win32-arm64';

export type CliFlavor = 'claude' | 'agent_teams_orchestrator';

export type CliProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode';
export type CliProviderAuthMode = 'auto' | 'oauth' | 'chatgpt' | 'api_key';
export const CLI_PROVIDER_STATUS_DEFERRED_MESSAGE = 'Provider status will refresh when needed.';
export const CLI_PROVIDER_STATUS_UNAVAILABLE_MESSAGE = 'Provider status unavailable';

export interface CliProviderConnectionInfo {
  supportsOAuth: boolean;
  supportsApiKey: boolean;
  configurableAuthModes: CliProviderAuthMode[];
  configuredAuthMode: CliProviderAuthMode | null;
  apiKeyConfigured: boolean;
  apiKeySource: 'stored' | 'environment' | null;
  apiKeySourceLabel?: string | null;
  compatibleEndpoint?: {
    enabled: boolean;
    baseUrl: string;
    tokenConfigured: boolean;
    tokenSource: 'stored' | 'environment' | null;
    tokenSourceLabel?: string | null;
  } | null;
  codex?: {
    preferredAuthMode: CodexAccountAuthMode;
    effectiveAuthMode: CodexAccountEffectiveAuthMode;
    appServerState: CodexAccountAppServerState;
    appServerStatusMessage: string | null;
    managedAccount: CodexManagedAccountDto | null;
    requiresOpenaiAuth: boolean | null;
    localAccountArtifactsPresent?: boolean;
    localActiveChatgptAccountPresent?: boolean;
    login: CodexLoginStateDto;
    rateLimits: CodexRateLimitSnapshotDto | null;
    launchAllowed: boolean;
    launchIssueMessage: string | null;
    launchReadinessState: CodexLaunchReadinessState;
    customProvider?: {
      enabled: boolean;
      active: boolean;
      baseUrl: string;
      model: string;
      issueMessage: string | null;
    };
  } | null;
}

export interface CliProviderBackendOption {
  id: string;
  label: string;
  description: string;
  selectable: boolean;
  recommended: boolean;
  available: boolean;
  state?:
    | 'ready'
    | 'locked'
    | 'disabled'
    | 'authentication-required'
    | 'runtime-missing'
    | 'degraded';
  audience?: 'general' | 'internal';
  statusMessage?: string | null;
  detailMessage?: string | null;
}

export interface CliExternalRuntimeDiagnostic {
  id: string;
  label: string;
  detected: boolean;
  statusMessage?: string | null;
  detailMessage?: string | null;
}

export type CliExtensionCapabilityStatus = 'supported' | 'read-only' | 'unsupported';
export type CliExtensionOwnership = 'shared' | 'provider-scoped';

export interface CliExtensionCapability {
  status: CliExtensionCapabilityStatus;
  ownership: CliExtensionOwnership;
  reason?: string | null;
}

export interface CliExtensionCapabilities {
  plugins: CliExtensionCapability;
  mcp: CliExtensionCapability;
  skills: CliExtensionCapability;
  apiKeys: CliExtensionCapability;
}

export type CliProviderModelAvailabilityStatus =
  | 'checking'
  | 'available'
  | 'unavailable'
  | 'unknown';

export interface CliProviderModelAvailability {
  modelId: string;
  status: CliProviderModelAvailabilityStatus;
  reason?: string | null;
  checkedAt?: string | null;
}

export type CliProviderReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';

export type CliProviderModelCatalogSource =
  | 'anthropic-models-api'
  | 'anthropic-compatible-api'
  | 'app-server'
  | 'static-fallback';
export type CliProviderModelCatalogStatus = 'ready' | 'stale' | 'degraded' | 'unavailable';

export type OpenCodeModelAccessKind =
  | 'no_model'
  | 'unknown_model'
  | 'credentialed'
  | 'builtin_free'
  | 'configured_authless'
  | 'verified'
  | 'not_authenticated'
  | 'execution_failed';

export type OpenCodeModelRouteKind =
  | 'connected_provider'
  | 'builtin_free'
  | 'configured_local'
  | 'catalog_provider';

export type OpenCodeModelProofState = 'not_required' | 'needs_probe' | 'verified' | 'failed';

export interface OpenCodeModelRouteMetadata {
  providerId: string | null;
  modelId: string | null;
  sourceLabel: string | null;
  accessKind: OpenCodeModelAccessKind;
  routeKind: OpenCodeModelRouteKind;
  proofState: OpenCodeModelProofState;
  requiresExecutionProof: boolean;
  reason: string | null;
}

export interface CliProviderModelCatalogItem {
  id: string;
  launchModel: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: CliProviderReasoningEffort[];
  defaultReasoningEffort: CliProviderReasoningEffort | null;
  supportsFastMode?: boolean;
  inputModalities: string[];
  supportsPersonality: boolean;
  isDefault: boolean;
  upgrade: boolean;
  source: CliProviderModelCatalogSource;
  badgeLabel?: string | null;
  statusMessage?: string | null;
  metadata?: {
    cost?: unknown;
    context?: number | null;
    limits?: unknown;
    free?: boolean;
    releaseDate?: string | null;
    opencode?: OpenCodeModelRouteMetadata | null;
  } | null;
}

export interface CliProviderModelCatalog {
  schemaVersion: 1;
  providerId: CliProviderId;
  source: CliProviderModelCatalogSource;
  status: CliProviderModelCatalogStatus;
  fetchedAt: string;
  staleAt: string;
  defaultModelId: string | null;
  defaultLaunchModel: string | null;
  models: CliProviderModelCatalogItem[];
  diagnostics: {
    configReadState: 'ready' | 'unsupported' | 'failed' | 'skipped';
    appServerState: 'healthy' | 'degraded' | 'runtime-missing' | 'incompatible';
    message?: string | null;
    code?: string | null;
  };
}

export interface CliProviderRuntimeCapabilities {
  modelCatalog?: {
    dynamic: boolean;
    source?: CliProviderModelCatalogSource | 'runtime';
  };
  reasoningEffort?: {
    supported: boolean;
    values: CliProviderReasoningEffort[];
    configPassthrough?: boolean;
  };
  fastMode?: {
    supported: boolean;
    available: boolean;
    reason?: string | null;
    source: 'runtime';
  };
}

export interface CliProviderSubscriptionRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CliProviderSubscriptionRateLimitSnapshot {
  primary: CliProviderSubscriptionRateLimitWindow | null;
  secondary: CliProviderSubscriptionRateLimitWindow | null;
}

/** Whether the provider status can safely replace previously known runtime truth. */
export type CliProviderStatusCheckOutcome =
  | 'authoritative'
  | 'pending'
  | 'transient_error'
  | 'model_only';

/** Machine-readable reason when a provider-status check is incomplete or failed. */
export type CliProviderStatusCheckErrorCode =
  | 'timeout'
  | 'unavailable'
  | 'runtime_missing'
  | 'partial_response';

export interface CliProviderStatus {
  providerId: CliProviderId;
  displayName: string;
  supported: boolean;
  authenticated: boolean;
  authMethod: string | null;
  verificationState: 'verified' | 'unknown' | 'offline' | 'error';
  /** Optional for compatibility with runtimes that predate typed status-check outcomes. */
  statusCheckOutcome?: CliProviderStatusCheckOutcome;
  statusCheckErrorCode?: CliProviderStatusCheckErrorCode;
  modelVerificationState?: 'idle' | 'verifying' | 'verified';
  statusMessage?: string | null;
  detailMessage?: string | null;
  models: string[];
  modelCatalog?: CliProviderModelCatalog | null;
  modelCatalogRefreshState?: 'idle' | 'loading' | 'ready' | 'error';
  modelAvailability?: CliProviderModelAvailability[];
  runtimeCapabilities?: CliProviderRuntimeCapabilities | null;
  subscriptionRateLimits?: CliProviderSubscriptionRateLimitSnapshot | null;
  canLoginFromUi: boolean;
  capabilities: {
    teamLaunch: boolean;
    oneShot: boolean;
    extensions: CliExtensionCapabilities;
  };
  selectedBackendId?: string | null;
  resolvedBackendId?: string | null;
  availableBackends?: CliProviderBackendOption[];
  externalRuntimeDiagnostics?: CliExternalRuntimeDiagnostic[];
  backend?: {
    kind: string;
    label: string;
    endpointLabel?: string | null;
    projectId?: string | null;
    authMethodDetail?: string | null;
  } | null;
  connection?: CliProviderConnectionInfo | null;
}

export interface CliFlavorUiOptions {
  displayName: string;
  supportsSelfUpdate: boolean;
  showVersionDetails: boolean;
  showBinaryPath: boolean;
}

// =============================================================================
// Installation Status
// =============================================================================

/**
 * Current CLI installation status returned by getStatus().
 */
export interface CliInstallationStatus {
  /** Selected CLI runtime flavor */
  flavor: CliFlavor;
  /** Display label for the configured runtime */
  displayName: string;
  /** Whether this runtime should expose self-update/install actions in the UI */
  supportsSelfUpdate: boolean;
  /** Whether version text should be shown in the UI */
  showVersionDetails: boolean;
  /** Whether binary path should be shown in the UI */
  showBinaryPath: boolean;
  /** Whether the CLI is available. Lightweight startup status may defer the health check. */
  installed: boolean;
  /** Installed version string (e.g. "2.1.59"), null if unavailable or not installed */
  installedVersion: string | null;
  /** Absolute path to the resolved binary candidate, null if not found */
  binaryPath: string | null;
  /** Probe failure when a binary was found but could not be started */
  launchError?: string | null;
  /** Latest available version from GCS, null if check failed */
  latestVersion: string | null;
  /** True when installed version < latest version */
  updateAvailable: boolean;
  /** Whether user is logged in (claude auth status) */
  authLoggedIn: boolean;
  /** Whether runtime authentication status is still being checked */
  authStatusChecking: boolean;
  /** Auth method if logged in (e.g. "oauth_token", "api_key"), null otherwise */
  authMethod: string | null;
  /** Provider-level runtime status when supported by the configured runtime */
  providers: CliProviderStatus[];
}

// =============================================================================
// Installer Progress Events
// =============================================================================

/**
 * Progress event sent from main→renderer during CLI install/update.
 */
export interface CliInstallerProgress {
  /** Current phase of the installation process */
  type: 'checking' | 'downloading' | 'verifying' | 'installing' | 'completed' | 'error' | 'status';
  /** Download progress 0-100, only present for 'downloading' */
  percent?: number;
  /** Bytes downloaded so far */
  transferred?: number;
  /** Total bytes to download (may be undefined if Content-Length absent) */
  total?: number;
  /** Installed version string, only present for 'completed' */
  version?: string;
  /** Error message, only present for 'error' */
  error?: string;
  /** Status detail text (e.g. stdout lines from `claude install`) */
  detail?: string;
  /** Raw terminal output chunk (with ANSI codes), only for 'installing' */
  rawChunk?: string;
  /** Partial or full CLI status snapshot during status gathering. */
  status?: CliInstallationStatus;
}

export type CliInstallerProviderStatusMode = 'full' | 'defer';

export interface CliInstallerGetStatusOptions {
  /**
   * `defer` keeps startup lightweight by checking only the runtime binary/version.
   * Explicit refreshes should keep the default `full` mode.
   */
  providerStatusMode?: CliInstallerProviderStatusMode;
}

export interface CliProviderStatusRequestOptions {
  /**
   * Project whose runtime configuration should be resolved. OpenCode uses the
   * command cwd to merge global and project-local provider configuration.
   */
  projectPath?: string | null;
}

/** Security purpose carried across the renderer/preload/main status boundary. */
export type CliProviderStatusRequestPurpose = 'passive' | 'launch-proof';

/**
 * Renderer request identity for a provider observation. Purpose and nonce are
 * required so legacy callers cannot accidentally obtain launch authority.
 */
export interface CliProviderStatusIpcRequest extends CliProviderStatusRequestOptions {
  purpose: CliProviderStatusRequestPurpose;
  requestNonce: string;
}

/** Main-owned launch authority generation for one exact provider/project scope. */
export interface CliProviderStatusAuthorityScope {
  schemaVersion: 1;
  providerId: CliProviderId;
  projectPath: string | null;
  globalGeneration: number;
  profileGeneration: number;
  catalogGeneration: number;
}

/** Main-issued metadata binding a provider observation to its exact request. */
export interface CliProviderStatusIpcResponse {
  providerStatus: CliProviderStatus | null;
  purpose: CliProviderStatusRequestPurpose;
  requestNonce: string;
  observationGeneration: number;
  observationNonce: string;
  /** Missing on legacy payloads, which are display-only and never launch-ready. */
  authorityScope?: CliProviderStatusAuthorityScope | null;
}

const CLI_PROVIDER_STATUS_NONCE_MAX_LENGTH = 256;
let cliProviderStatusRequestSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCliProviderStatusIpcRequest(value: unknown): CliProviderStatusIpcRequest {
  if (!isRecord(value)) throw new Error('Provider status request must be an object');
  if (value.purpose !== 'passive' && value.purpose !== 'launch-proof') {
    throw new Error('Provider status request purpose is invalid');
  }
  if (
    typeof value.requestNonce !== 'string' ||
    value.requestNonce.length === 0 ||
    value.requestNonce.length > CLI_PROVIDER_STATUS_NONCE_MAX_LENGTH
  ) {
    throw new Error('Provider status request nonce is invalid');
  }
  if (
    value.projectPath !== undefined &&
    value.projectPath !== null &&
    typeof value.projectPath !== 'string'
  ) {
    throw new Error('Provider status project path is invalid');
  }
  return value as unknown as CliProviderStatusIpcRequest;
}

export function parseCliProviderStatusIpcResponse(value: unknown): CliProviderStatusIpcResponse {
  if (!isRecord(value)) throw new Error('Provider status response is invalid');
  if (value.purpose !== 'passive' && value.purpose !== 'launch-proof') {
    throw new Error('Provider status response purpose is invalid');
  }
  if (
    typeof value.requestNonce !== 'string' ||
    value.requestNonce.length === 0 ||
    typeof value.observationNonce !== 'string' ||
    value.observationNonce.length === 0 ||
    !Number.isSafeInteger(value.observationGeneration) ||
    (value.observationGeneration as number) < 0
  ) {
    throw new Error('Provider status response metadata is invalid');
  }
  if (value.authorityScope !== undefined && value.authorityScope !== null) {
    if (!isRecord(value.authorityScope)) {
      throw new Error('Provider status authority scope is invalid');
    }
    const scope = value.authorityScope;
    if (
      scope.schemaVersion !== 1 ||
      typeof scope.providerId !== 'string' ||
      (scope.projectPath !== null && typeof scope.projectPath !== 'string') ||
      !Number.isSafeInteger(scope.globalGeneration) ||
      (scope.globalGeneration as number) < 0 ||
      !Number.isSafeInteger(scope.profileGeneration) ||
      (scope.profileGeneration as number) < 0 ||
      !Number.isSafeInteger(scope.catalogGeneration) ||
      (scope.catalogGeneration as number) < 0
    ) {
      throw new Error('Provider status authority scope is invalid');
    }
  }
  if (
    value.providerStatus !== null &&
    (!isRecord(value.providerStatus) || typeof value.providerStatus.providerId !== 'string')
  ) {
    throw new Error('Provider status response payload is invalid');
  }
  return value as unknown as CliProviderStatusIpcResponse;
}

export function parseExactCliProviderStatusIpcResponse(
  value: unknown,
  request: CliProviderStatusIpcRequest
): CliProviderStatusIpcResponse {
  const response = parseCliProviderStatusIpcResponse(value);
  if (response.purpose !== request.purpose || response.requestNonce !== request.requestNonce) {
    throw new Error('Provider status response does not match the exact request');
  }
  return response;
}

export function resolveCliProviderStatusIpcResponse(
  value: unknown,
  request: CliProviderStatusIpcRequest
): {
  providerStatus: CliProviderStatus | null;
  metadataMatchesRequest: boolean;
  authorityScope: CliProviderStatusAuthorityScope | null;
} {
  try {
    const response = parseCliProviderStatusIpcResponse(value);
    const metadataMatchesRequest =
      response.purpose === request.purpose && response.requestNonce === request.requestNonce;
    return {
      providerStatus: metadataMatchesRequest ? response.providerStatus : null,
      metadataMatchesRequest,
      authorityScope: metadataMatchesRequest ? (response.authorityScope ?? null) : null,
    };
  } catch {
    const legacyPassiveStatus =
      request.purpose === 'passive' && isRecord(value) && typeof value.providerId === 'string'
        ? (value as unknown as CliProviderStatus)
        : null;
    return {
      providerStatus: legacyPassiveStatus,
      metadataMatchesRequest: false,
      authorityScope: null,
    };
  }
}

export async function requestCliProviderStatusIpcResponse(
  getStatus: (providerId: CliProviderId, request: CliProviderStatusIpcRequest) => Promise<unknown>,
  providerId: CliProviderId,
  purpose: CliProviderStatusRequestPurpose,
  projectPath: string | null
): Promise<{
  providerStatus: CliProviderStatus | null;
  metadataMatchesRequest: boolean;
  authorityScope: CliProviderStatusAuthorityScope | null;
}> {
  const request = {
    ...(projectPath ? { projectPath } : {}),
    purpose,
    requestNonce:
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++cliProviderStatusRequestSequence}`,
  };
  return resolveCliProviderStatusIpcResponse(await getStatus(providerId, request), request);
}

// =============================================================================
// Preload API
// =============================================================================

/**
 * CLI Installer API exposed via preload bridge.
 */
export interface CliInstallerAPI {
  /** Get current CLI installation status */
  getStatus: (options?: CliInstallerGetStatusOptions) => Promise<CliInstallationStatus>;
  /** Get current runtime/auth status for a single provider */
  getProviderStatus: (
    providerId: CliProviderId,
    request: CliProviderStatusIpcRequest
  ) => Promise<CliProviderStatusIpcResponse>;
  /** Start on-demand model verification for a single runtime provider */
  verifyProviderModels: (providerId: CliProviderId) => Promise<CliProviderStatus | null>;
  /** Start install/update flow. Progress sent via onProgress events. */
  install: () => Promise<void>;
  /** Invalidate cached status (forces fresh check on next getStatus) */
  invalidateStatus: () => Promise<void>;
  /** Subscribe to progress events. Returns cleanup function. */
  onProgress: (cb: (event: unknown, data: CliInstallerProgress) => void) => () => void;
}

// =============================================================================
// OpenCode Runtime Installer
// =============================================================================

export type OpenCodeRuntimeSource = 'app-managed' | 'path' | 'missing';

export type OpenCodeRuntimeInstallerState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'failed';

export interface OpenCodeRuntimeInstallProgress {
  phase: OpenCodeRuntimeInstallerState;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  detail?: string | null;
}

export interface OpenCodeRuntimeStatus {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  source: OpenCodeRuntimeSource;
  state: OpenCodeRuntimeInstallerState;
  progress?: OpenCodeRuntimeInstallProgress;
  error?: string;
}

export interface OpenCodeRuntimeAPI {
  getStatus: () => Promise<OpenCodeRuntimeStatus>;
  install: () => Promise<OpenCodeRuntimeStatus>;
  invalidateStatus: () => Promise<void>;
  onProgress: (cb: (event: unknown, data: OpenCodeRuntimeStatus) => void) => () => void;
}
