/**
 * CLI Installer types — shared between main, preload, and renderer processes.
 *
 * Used for detecting, downloading, verifying, and installing Claude Code CLI binary.
 */

import type {
  CodexAccountAppServerState,
  CodexAccountAuthMode,
  CodexAccountEffectiveAuthMode,
  CodexLoginStateDto,
  CodexLaunchReadinessState,
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

export type CliProviderId = 'anthropic' | 'codex' | 'gemini';
export type CliProviderAuthMode = 'auto' | 'oauth' | 'chatgpt' | 'api_key';

export interface CliProviderConnectionInfo {
  supportsOAuth: boolean;
  supportsApiKey: boolean;
  configurableAuthModes: CliProviderAuthMode[];
  configuredAuthMode: CliProviderAuthMode | null;
  apiKeyConfigured: boolean;
  apiKeySource: 'stored' | 'environment' | null;
  apiKeySourceLabel?: string | null;
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

export interface CliProviderStatus {
  providerId: CliProviderId;
  displayName: string;
  supported: boolean;
  authenticated: boolean;
  authMethod: string | null;
  verificationState: 'verified' | 'unknown' | 'offline' | 'error';
  modelVerificationState?: 'idle' | 'verifying' | 'verified';
  statusMessage?: string | null;
  models: string[];
  modelAvailability?: CliProviderModelAvailability[];
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
  /** Whether the CLI was found and passed the startup health check (`--version`) */
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

// =============================================================================
// Preload API
// =============================================================================

/**
 * CLI Installer API exposed via preload bridge.
 */
export interface CliInstallerAPI {
  /** Get current CLI installation status */
  getStatus: () => Promise<CliInstallationStatus>;
  /** Get current runtime/auth status for a single provider */
  getProviderStatus: (providerId: CliProviderId) => Promise<CliProviderStatus | null>;
  /** Start on-demand model verification for a single runtime provider */
  verifyProviderModels: (providerId: CliProviderId) => Promise<CliProviderStatus | null>;
  /** Start install/update flow. Progress sent via onProgress events. */
  install: () => Promise<void>;
  /** Invalidate cached status (forces fresh check on next getStatus) */
  invalidateStatus: () => Promise<void>;
  /** Subscribe to progress events. Returns cleanup function. */
  onProgress: (cb: (event: unknown, data: CliInstallerProgress) => void) => () => void;
}
