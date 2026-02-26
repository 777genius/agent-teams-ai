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

// =============================================================================
// Installation Status
// =============================================================================

/**
 * Current CLI installation status returned by getStatus().
 */
export interface CliInstallationStatus {
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
}

// =============================================================================
// Installer Progress Events
// =============================================================================

/**
 * Progress event sent from main→renderer during CLI install/update.
 */
export interface CliInstallerProgress {
  /** Current phase of the installation process */
  type: 'checking' | 'downloading' | 'verifying' | 'installing' | 'completed' | 'error';
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
  /** Subscribe to progress events. Returns cleanup function. */
  onProgress: (cb: (event: unknown, data: CliInstallerProgress) => void) => () => void;
}
