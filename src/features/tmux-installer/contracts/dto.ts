export type TmuxPlatform = 'darwin' | 'linux' | 'win32' | 'unknown';

export type TmuxInstallStrategy =
  | 'homebrew'
  | 'macports'
  | 'apt'
  | 'dnf'
  | 'yum'
  | 'zypper'
  | 'pacman'
  | 'wsl'
  | 'manual'
  | 'unknown';

export type TmuxInstallerPhase =
  | 'idle'
  | 'checking'
  | 'preparing'
  | 'requesting_privileges'
  | 'pending_external_elevation'
  | 'waiting_for_external_step'
  | 'installing'
  | 'verifying'
  | 'needs_restart'
  | 'needs_manual_step'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface TmuxInstallHint {
  title: string;
  description: string;
  command?: string;
  url?: string;
}

export interface TmuxAutoInstallCapability {
  supported: boolean;
  strategy: TmuxInstallStrategy;
  packageManagerLabel?: string | null;
  requiresTerminalInput: boolean;
  requiresAdmin: boolean;
  requiresRestart: boolean;
  mayOpenExternalWindow?: boolean;
  reasonIfUnsupported?: string | null;
  manualHints: TmuxInstallHint[];
}

export interface TmuxWslStatus {
  wslInstalled: boolean;
  rebootRequired: boolean;
  distroName: string | null;
  distroVersion: 1 | 2 | null;
  distroBootstrapped: boolean;
  innerPackageManager: TmuxInstallStrategy | null;
  tmuxAvailableInsideWsl: boolean;
  tmuxVersion: string | null;
  tmuxBinaryPath: string | null;
  statusDetail: string | null;
}

export interface TmuxWslPreference {
  preferredDistroName: string | null;
  source: 'persisted' | 'default' | 'manual' | null;
}

export interface TmuxBinaryProbe {
  available: boolean;
  version: string | null;
  binaryPath: string | null;
  error: string | null;
}

export interface TmuxEffectiveAvailability {
  available: boolean;
  location: 'host' | 'wsl' | null;
  version: string | null;
  binaryPath: string | null;
  runtimeReady: boolean;
  detail: string | null;
}

export interface TmuxStatus {
  platform: TmuxPlatform;
  nativeSupported: boolean;
  checkedAt: string;
  host: TmuxBinaryProbe;
  effective: TmuxEffectiveAvailability;
  error: string | null;
  autoInstall: TmuxAutoInstallCapability;
  wsl?: TmuxWslStatus | null;
  wslPreference?: TmuxWslPreference | null;
}

export interface TmuxInstallerSnapshot {
  phase: TmuxInstallerPhase;
  strategy: TmuxInstallStrategy | null;
  message: string | null;
  detail: string | null;
  error: string | null;
  canCancel: boolean;
  acceptsInput: boolean;
  inputPrompt: string | null;
  inputSecret: boolean;
  logs: string[];
  updatedAt: string;
}

export type TmuxInstallerProgress = TmuxInstallerSnapshot;
