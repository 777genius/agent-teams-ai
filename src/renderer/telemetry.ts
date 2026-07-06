import { syncPostHogTelemetry } from './posthog';
import { syncRendererTelemetry as syncSentryRendererTelemetry } from './sentry';

export function syncRendererTelemetry(enabled: boolean): void {
  syncSentryRendererTelemetry(enabled);
  syncPostHogTelemetry(enabled);
}
