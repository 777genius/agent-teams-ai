import { api } from './api';
import { syncPostHogTelemetry } from './posthog';
import { syncRendererTelemetry as syncSentryRendererTelemetry } from './sentry';

let telemetryConfigSyncToken = 0;

export function syncRendererTelemetry(enabled: boolean): void {
  telemetryConfigSyncToken++;
  syncSentryRendererTelemetry(enabled);
  syncPostHogTelemetry(enabled);
}

export async function bootstrapRendererTelemetryFromConfig(): Promise<void> {
  const syncToken = telemetryConfigSyncToken;
  try {
    const config = await api.config.get();
    if (syncToken !== telemetryConfigSyncToken) {
      return;
    }
    syncRendererTelemetry(config.general?.telemetryEnabled ?? true);
  } catch {
    // Keep telemetry closed if persisted opt-in cannot be read.
  }
}
