/**
 * CLI Installer types — shared between main, preload, and renderer processes.
 *
 * Used for detecting, downloading, verifying, and installing Claude Code CLI binary.
 */

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

export type CliFlavor = 'claude' | 'free-code';

export type CliProviderId = 'anthropic' | 'codex' | 'gemini';

export interface CliProviderStatus {
  providerId: CliProviderId;
  displayName: string;
  supported: boolean;
  authenticated: boolean;
  authMethod: string | null;
  verificationState: 'verified' | 'unknown' | 'offline' | 'error';
  statusMessage?: string | null;
  models: string[];
  canLoginFromUi: boolean;
  capabilities: {
    teamLaunch: boolean;
    oneShot: boolean;
  };
  backend?: {
    kind: string;
    label: string;
    endpointLabel?: string | null;
    projectId?: string | null;
    authMethodDetail?: string | null;
  } | null;
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
  /** Whether CLI binary is found on the system */
  installed: boolean;
  /** Installed version string (e.g. "2.1.59"), null if not installed */
  installedVersion: string | null;
  /** Absolute path to the resolved binary, null if not found */
  binaryPath: string | null;
  /** Latest available version from GCS, null if check failed */
  latestVersion: string | null;
  /** True when installed version < latest version */
  updateAvailable: boolean;
  /** Whether user is logged in (claude auth status) */
  authLoggedIn: boolean;
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
  /** Start install/update flow. Progress sent via onProgress events. */
  install: () => Promise<void>;
  /** Invalidate cached status (forces fresh check on next getStatus) */
  invalidateStatus: () => Promise<void>;
  /** Subscribe to progress events. Returns cleanup function. */
  onProgress: (cb: (event: unknown, data: CliInstallerProgress) => void) => () => void;
}
