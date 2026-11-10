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
