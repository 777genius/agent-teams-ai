// =============================================================================
// Telemetry API
// =============================================================================

export interface SentryTelemetryContext {
  userId: string;
  tags: Record<string, string>;
}

export interface SentryTelemetryStatus {
  state: 'disabled' | 'unconfigured' | 'active' | 'failed';
  reason: 'telemetry-disabled' | 'invalid-dsn' | 'sdk-load-failed' | 'sdk-init-failed' | null;
  environment: 'production' | 'development';
  release: string | null;
}

export interface TelemetryAPI {
  getSentryContext: () => Promise<SentryTelemetryContext | null>;
  getSentryStatus: () => Promise<SentryTelemetryStatus>;
}

export interface WindowsElevationStatus {
  platform: string;
  isWindows: boolean;
  isAdministrator: boolean | null;
  checkFailed: boolean;
  error: string | null;
}

/** Existing shell and window controls exposed by the Desktop preload. */
export interface DesktopShellApi {
  // Shell operations
  openPath: (
    targetPath: string,
    projectRoot?: string,
    userSelectedFromDialog?: boolean
  ) => Promise<{ success: boolean; error?: string }>;
  showInFolder: (filePath: string) => Promise<void>;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  getDiscordMemberCount: () => Promise<{ count: number | null; error?: string }>;

  // Window controls (when title bar is hidden, e.g. Windows / Linux)
  windowControls: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    isFullScreen: () => Promise<boolean>;
    relaunch: () => Promise<void>;
  };

  /** Subscribe to fullscreen changes (e.g. to remove macOS traffic light padding in fullscreen) */
  onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void;
}
