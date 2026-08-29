import { CLI_PROVIDER_STATUS_UNAVAILABLE_MESSAGE } from '@shared/types/cliInstaller';
import {
  createDefaultCliExtensionCapabilities,
  createLegacyRuntimeFallbackCliExtensionCapabilities,
} from '@shared/utils/providerExtensionCapabilities';

import type {
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusCheckErrorCode,
  CliProviderStatusCheckOutcome,
} from '@shared/types';

export interface RuntimeExtensionCapabilityResponse {
  status?: 'supported' | 'read-only' | 'unsupported';
  ownership?: 'shared' | 'provider-scoped';
  reason?: string | null;
}

export interface RuntimeExtensionCapabilitiesResponse {
  plugins?: RuntimeExtensionCapabilityResponse;
  mcp?: RuntimeExtensionCapabilityResponse;
  skills?: RuntimeExtensionCapabilityResponse;
  apiKeys?: RuntimeExtensionCapabilityResponse;
}

interface ProviderStatusCheck {
  statusCheckOutcome: CliProviderStatusCheckOutcome;
  statusCheckErrorCode?: CliProviderStatusCheckErrorCode;
}

const STATUS_CHECK_OUTCOMES = new Set<CliProviderStatusCheckOutcome>([
  'authoritative',
  'pending',
  'transient_error',
  'model_only',
]);
const STATUS_CHECK_ERROR_CODES = new Set<CliProviderStatusCheckErrorCode>([
  'timeout',
  'unavailable',
  'runtime_missing',
  'partial_response',
]);

function getProviderDisplayName(providerId: CliProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'OpenCode (200+ models)';
  }
}

function isStatusCheckOutcome(value: unknown): value is CliProviderStatusCheckOutcome {
  return (
    typeof value === 'string' && STATUS_CHECK_OUTCOMES.has(value as CliProviderStatusCheckOutcome)
  );
}

function isStatusCheckErrorCode(value: unknown): value is CliProviderStatusCheckErrorCode {
  return (
    typeof value === 'string' &&
    STATUS_CHECK_ERROR_CODES.has(value as CliProviderStatusCheckErrorCode)
  );
}

function getLegacyRuntimeProviderStatusCheck(
  record: Record<string, unknown> | null
): ProviderStatusCheck | null {
  const diagnostic = [record?.statusMessage, record?.detailMessage]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  if (diagnostic.includes('opencode inventory probe timed out')) {
    return {
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
    };
  }

  return null;
}

function hasAuthoritativeLaunchEvidence(provider: CliProviderStatus): boolean {
  const catalog = provider.modelCatalog;
  const requiresCatalog = provider.runtimeCapabilities?.modelCatalog?.dynamic === true;
  const catalogIsReady =
    catalog?.providerId === provider.providerId && catalog.status === 'ready';
  return (
    provider.statusCheckOutcome === 'authoritative' &&
    provider.statusCheckErrorCode == null &&
    provider.verificationState === 'verified' &&
    (!catalog || catalogIsReady) &&
    (!requiresCatalog || catalogIsReady)
  );
}

function isCompleteRuntimeProviderStatus(
  value: unknown,
  expectedProviderId?: CliProviderId
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const status = value as Record<string, unknown>;
  const capabilities = status.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return false;
  }

  const capabilityRecord = capabilities as Record<string, unknown>;
  const backend = status.backend;
  const verificationState = status.verificationState;
  return (
    typeof status.providerId === 'string' &&
    (expectedProviderId === undefined || status.providerId === expectedProviderId) &&
    typeof status.supported === 'boolean' &&
    typeof status.authenticated === 'boolean' &&
    (typeof status.authMethod === 'string' || status.authMethod === null) &&
    (verificationState === 'verified' ||
      verificationState === 'unknown' ||
      verificationState === 'offline' ||
      verificationState === 'error') &&
    typeof status.canLoginFromUi === 'boolean' &&
    typeof capabilityRecord.teamLaunch === 'boolean' &&
    typeof capabilityRecord.oneShot === 'boolean' &&
    Boolean(capabilityRecord.extensions) &&
    typeof capabilityRecord.extensions === 'object' &&
    !Array.isArray(capabilityRecord.extensions) &&
    (typeof status.selectedBackendId === 'string' || status.selectedBackendId === null) &&
    (typeof status.resolvedBackendId === 'string' || status.resolvedBackendId === null) &&
    Array.isArray(status.availableBackends) &&
    Array.isArray(status.externalRuntimeDiagnostics) &&
    (backend === null || (typeof backend === 'object' && !Array.isArray(backend))) &&
    (typeof status.statusMessage === 'string' || status.statusMessage === null) &&
    (typeof status.detailMessage === 'string' || status.detailMessage === null) &&
    Array.isArray(status.models)
  );
}

export function createDefaultProviderStatus(providerId: CliProviderId): CliProviderStatus {
  return {
    providerId,
    displayName: getProviderDisplayName(providerId),
    supported: false,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusCheckOutcome: 'pending',
    statusCheckErrorCode: 'partial_response',
    modelVerificationState: 'idle',
    modelCatalogRefreshState: 'idle',
    statusMessage: null,
    detailMessage: null,
    models: [],
    modelAvailability: [],
    canLoginFromUi: providerId !== 'opencode',
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: createLegacyRuntimeFallbackCliExtensionCapabilities(),
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    connection: null,
    modelCatalog: null,
    runtimeCapabilities: null,
    subscriptionRateLimits: null,
  };
}

export function createPendingProviderStatus(providerId: CliProviderId): CliProviderStatus {
  return {
    ...createDefaultProviderStatus(providerId),
    statusMessage: 'Checking...',
  };
}

export function getProviderStatusCheckErrorCode(error: unknown): CliProviderStatusCheckErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return 'timeout';
  }
  if (lower.includes('runtime missing') || lower.includes('runtime was not found')) {
    return 'runtime_missing';
  }
  return 'unavailable';
}

export function createRuntimeStatusErrorProviderStatus(
  providerId: CliProviderId,
  error: unknown
): CliProviderStatus {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = getProviderStatusCheckErrorCode(error);
  const isOpenCodeTimeout = providerId === 'opencode' && errorCode === 'timeout';
  return {
    ...createDefaultProviderStatus(providerId),
    verificationState: 'error',
    statusCheckOutcome: 'transient_error',
    statusCheckErrorCode: errorCode,
    statusMessage: isOpenCodeTimeout
      ? 'OpenCode is still loading'
      : CLI_PROVIDER_STATUS_UNAVAILABLE_MESSAGE,
    detailMessage: isOpenCodeTimeout
      ? 'OpenCode is taking longer than expected to load provider status. Your saved connections were not changed. Retry in a moment.'
      : message,
  };
}

/** Retains same-scope display evidence while revoking authentication and launch authority. */
export function createDegradedProviderStatus(
  previous: CliProviderStatus,
  error: unknown
): CliProviderStatus {
  const degraded = createRuntimeStatusErrorProviderStatus(previous.providerId, error);
  return {
    ...previous,
    authenticated: false,
    authMethod: null,
    verificationState: degraded.verificationState,
    statusCheckOutcome: degraded.statusCheckOutcome,
    statusCheckErrorCode: degraded.statusCheckErrorCode,
    statusMessage: degraded.statusMessage,
    detailMessage: degraded.detailMessage,
    capabilities: {
      ...previous.capabilities,
      teamLaunch: false,
    },
    modelCatalog: previous.modelCatalog ? { ...previous.modelCatalog, status: 'stale' } : null,
    modelCatalogRefreshState: previous.modelCatalog ? 'error' : degraded.modelCatalogRefreshState,
  };
}

function hasRetainedModelEvidence(
  incoming: CliProviderStatus,
  current: CliProviderStatus
): boolean {
  return (
    incoming.models.length === 0 &&
    (incoming.modelAvailability?.length ?? 0) === 0 &&
    !(incoming.modelCatalog?.status === 'ready' && incoming.modelCatalog.models.length > 0) &&
    (current.models.length > 0 || (current.modelAvailability?.length ?? 0) > 0)
  );
}

/**
 * Merges only same-provider display evidence. Retained, stale, or incomplete
 * evidence can remain visible, but can never preserve authentication or launch.
 */
export function mergeProviderStatusDisplayEvidence(
  incoming: CliProviderStatus,
  current: CliProviderStatus
): CliProviderStatus {
  if (incoming.providerId !== current.providerId) {
    return createRuntimeStatusErrorProviderStatus(
      current.providerId,
      new Error('Provider status response did not match the requested provider')
    );
  }

  const catalogRetained = incoming.modelCatalog == null && current.modelCatalog != null;
  const modelsRetained = hasRetainedModelEvidence(incoming, current);
  const launchUnproved =
    !hasAuthoritativeLaunchEvidence(incoming) || catalogRetained || modelsRetained;
  const retainedCatalog = incoming.modelCatalog ?? current.modelCatalog ?? null;
  const modelCatalog =
    retainedCatalog && launchUnproved
      ? { ...retainedCatalog, status: 'stale' as const }
      : retainedCatalog;

  return {
    ...incoming,
    supported: incoming.supported,
    authenticated: launchUnproved ? false : incoming.authenticated,
    authMethod: launchUnproved ? null : incoming.authMethod,
    verificationState: launchUnproved
      ? incoming.verificationState === 'error' || incoming.verificationState === 'offline'
        ? incoming.verificationState
        : incoming.statusCheckOutcome === 'transient_error'
        ? 'error'
        : 'unknown'
      : incoming.verificationState,
    canLoginFromUi: launchUnproved ? current.canLoginFromUi : incoming.canLoginFromUi,
    capabilities: launchUnproved
      ? { ...incoming.capabilities, teamLaunch: false }
      : incoming.capabilities,
    selectedBackendId: launchUnproved ? current.selectedBackendId : incoming.selectedBackendId,
    resolvedBackendId: launchUnproved ? current.resolvedBackendId : incoming.resolvedBackendId,
    models: incoming.models.length > 0 ? incoming.models : current.models,
    modelAvailability:
      (incoming.modelAvailability?.length ?? 0) > 0
        ? incoming.modelAvailability
        : current.modelAvailability,
    availableBackends:
      (incoming.availableBackends?.length ?? 0) > 0
        ? incoming.availableBackends
        : current.availableBackends,
    externalRuntimeDiagnostics:
      (incoming.externalRuntimeDiagnostics?.length ?? 0) > 0
        ? incoming.externalRuntimeDiagnostics
        : current.externalRuntimeDiagnostics,
    backend: incoming.backend ?? current.backend,
    connection: incoming.connection ?? current.connection,
    modelCatalog,
    modelCatalogRefreshState:
      modelCatalog && launchUnproved
        ? incoming.modelCatalogRefreshState === 'loading'
          ? 'loading'
          : 'error'
        : (incoming.modelCatalogRefreshState ?? current.modelCatalogRefreshState ?? 'idle'),
    runtimeCapabilities: incoming.runtimeCapabilities ?? current.runtimeCapabilities ?? null,
    subscriptionRateLimits:
      incoming.subscriptionRateLimits ?? current.subscriptionRateLimits ?? null,
  };
}

/** Applies authority rules when no same-provider snapshot has been cached yet. */
export function sanitizeProviderStatusAuthority(provider: CliProviderStatus): CliProviderStatus {
  return mergeProviderStatusDisplayEvidence(
    provider,
    createDefaultProviderStatus(provider.providerId)
  );
}

export function applyProviderStatusCheck(
  provider: CliProviderStatus,
  statusCheckOutcome: CliProviderStatusCheckOutcome,
  statusCheckErrorCode?: CliProviderStatusCheckErrorCode
): CliProviderStatus {
  return {
    ...provider,
    statusCheckOutcome,
    statusCheckErrorCode,
  };
}

export function getLegacyProviderStatusCheck(
  providerId: CliProviderId,
  originalError: unknown
): ProviderStatusCheck {
  if (providerId === 'opencode') {
    return {
      statusCheckOutcome: 'model_only',
      statusCheckErrorCode: 'partial_response',
    };
  }

  return {
    statusCheckOutcome: 'transient_error',
    statusCheckErrorCode: getProviderStatusCheckErrorCode(originalError),
  };
}

/**
 * Untyped, legacy, or structurally incomplete responses never become
 * authoritative by inference. Only an explicit, complete authoritative
 * response may grant launch readiness.
 */
export function resolveRuntimeProviderStatusCheck(
  runtimeStatus: unknown,
  expectedProviderId?: CliProviderId
): ProviderStatusCheck {
  const record =
    runtimeStatus && typeof runtimeStatus === 'object' && !Array.isArray(runtimeStatus)
      ? (runtimeStatus as Record<string, unknown>)
      : null;
  const outcome = record?.statusCheckOutcome;
  const errorCode = record?.statusCheckErrorCode;

  if (outcome === 'authoritative') {
    if (!isCompleteRuntimeProviderStatus(runtimeStatus, expectedProviderId)) {
      return {
        statusCheckOutcome: 'pending',
        statusCheckErrorCode: 'partial_response',
      };
    }
    if (errorCode !== undefined && errorCode !== null) {
      const resolvedErrorCode = isStatusCheckErrorCode(errorCode) ? errorCode : 'partial_response';
      return {
        statusCheckOutcome:
          resolvedErrorCode === 'partial_response' ? 'pending' : 'transient_error',
        statusCheckErrorCode: resolvedErrorCode,
      };
    }
  }

  if (isStatusCheckOutcome(outcome)) {
    return {
      statusCheckOutcome: outcome,
      statusCheckErrorCode: isStatusCheckErrorCode(errorCode)
        ? errorCode
        : outcome === 'authoritative'
          ? undefined
          : outcome === 'transient_error'
            ? 'unavailable'
            : 'partial_response',
    };
  }

  const legacyStatusCheck = getLegacyRuntimeProviderStatusCheck(record);
  if (legacyStatusCheck) {
    return legacyStatusCheck;
  }

  return {
    statusCheckOutcome: 'pending',
    statusCheckErrorCode: 'partial_response',
  };
}

export function mapRuntimeExtensionCapabilities(
  providerId: CliProviderId,
  capabilities?: RuntimeExtensionCapabilitiesResponse
): CliProviderStatus['capabilities']['extensions'] {
  const defaults = capabilities
    ? createDefaultCliExtensionCapabilities()
    : createLegacyRuntimeFallbackCliExtensionCapabilities();
  const pluginStatus =
    providerId === 'opencode'
      ? 'unsupported'
      : (capabilities?.plugins?.status ?? defaults.plugins.status);
  const pluginReason =
    providerId === 'opencode'
      ? (capabilities?.plugins?.reason ??
        'OpenCode does not support plugin management from Agent Teams.')
      : (capabilities?.plugins?.reason ?? defaults.plugins.reason);

  return {
    plugins: {
      ...defaults.plugins,
      status: pluginStatus,
      ownership: capabilities?.plugins?.ownership ?? defaults.plugins.ownership,
      reason: pluginReason,
    },
    mcp: {
      ...defaults.mcp,
      status: capabilities?.mcp?.status ?? defaults.mcp.status,
      ownership: capabilities?.mcp?.ownership ?? defaults.mcp.ownership,
      reason: capabilities?.mcp?.reason ?? defaults.mcp.reason,
    },
    skills: {
      ...defaults.skills,
      status: capabilities?.skills?.status ?? defaults.skills.status,
      ownership: capabilities?.skills?.ownership ?? defaults.skills.ownership,
      reason: capabilities?.skills?.reason ?? defaults.skills.reason,
    },
    apiKeys: {
      ...defaults.apiKeys,
      status: capabilities?.apiKeys?.status ?? defaults.apiKeys.status,
      ownership: capabilities?.apiKeys?.ownership ?? defaults.apiKeys.ownership,
      reason: capabilities?.apiKeys?.reason ?? defaults.apiKeys.reason,
    },
  };
}
