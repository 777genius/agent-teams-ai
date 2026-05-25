/**
 * Sentry initialisation for the **renderer** process.
 *
 * Must be called before `ReactDOM.createRoot()` in `main.tsx`.
 * Supports both Electron (preload bridge) and standalone browser mode.
 *
 * When `VITE_SENTRY_DSN` is not set (dev / self-builds), everything is a no-op.
 */

import * as SentryElectron from '@sentry/electron/renderer';
import { browserTracingIntegration as reactBrowserTracing, init as reactInit } from '@sentry/react';
import {
  filterSafeSentryIntegrations,
  isValidDsn,
  redactSentryEvent,
  SENTRY_ENVIRONMENT,
  SENTRY_RELEASE,
  TRACES_SAMPLE_RATE,
} from '@shared/utils/sentryConfig';

import type { ElectronAPI } from '@shared/types/api';

// ---------------------------------------------------------------------------
// Telemetry gate (mirrors src/main/sentry.ts pattern)
// ---------------------------------------------------------------------------

// Start closed until persisted config is loaded through the store.
let telemetryAllowed = false;
let initialized = false;
let telemetryIdentitySyncToken = 0;

function getElectronApi(): ElectronAPI | undefined {
  return (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
}

function clearRendererSentryUser(): void {
  if (!initialized) return;
  SentryElectron.setUser?.(null);
}

async function syncRendererTelemetryIdentity(): Promise<void> {
  const syncToken = ++telemetryIdentitySyncToken;
  if (!initialized || !telemetryAllowed) {
    return;
  }

  const getSentryContext = getElectronApi()?.telemetry?.getSentryContext;
  if (!getSentryContext) {
    return;
  }

  try {
    const context = await getSentryContext();
    if (syncToken !== telemetryIdentitySyncToken || !telemetryAllowed) {
      return;
    }

    if (!context) {
      SentryElectron.setUser?.(null);
      return;
    }

    SentryElectron.setUser?.({ id: context.userId });
    SentryElectron.setTags?.(context.tags);
  } catch {
    if (syncToken === telemetryIdentitySyncToken) {
      SentryElectron.setUser?.(null);
    }
  }
}

function getSafeRendererErrorContext(
  context?: Record<string, unknown>
): Record<string, unknown> | null {
  if (!context) {
    return null;
  }

  return {
    activeTabType: typeof context.activeTabType === 'string' ? context.activeTabType : null,
    hasComponentStack:
      typeof context.componentStack === 'string' && context.componentStack.length > 0,
  };
}

/**
 * Sync the opt-in flag from config. Call after config is loaded
 * and whenever the user toggles telemetry in Settings.
 */
export function syncRendererTelemetry(enabled: boolean): void {
  telemetryAllowed = enabled;
  if (!enabled) {
    telemetryIdentitySyncToken++;
    clearRendererSentryUser();
    return;
  }

  initSentryRenderer();
  void syncRendererTelemetryIdentity();
}

export function initSentryRenderer(): void {
  if (initialized || !telemetryAllowed) return;

  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!isValidDsn(dsn)) return;

  const baseOptions = {
    dsn,
    release: SENTRY_RELEASE,
    environment: SENTRY_ENVIRONMENT,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-version @sentry/core type mismatch
  const beforeSend = (event: any): any => (telemetryAllowed ? redactSentryEvent(event) : null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-version @sentry/core type mismatch
  const beforeSendTransaction = (event: any): any =>
    telemetryAllowed ? redactSentryEvent(event) : null;

  if (getElectronApi()) {
    // Electron renderer - uses IPC transport to main process.
    // browserTracingIntegration from @sentry/electron/renderer to avoid
    // @sentry/core version mismatch with @sentry/react.
    SentryElectron.init({
      ...baseOptions,
      beforeSend,
      beforeSendTransaction,
      integrations: (integrations) => [
        ...filterSafeSentryIntegrations(integrations),
        SentryElectron.browserTracingIntegration(),
      ],
    });
  } else {
    // Standalone browser mode - direct HTTP transport
    reactInit({
      ...baseOptions,
      beforeSend,
      beforeSendTransaction,
      integrations: (integrations) => [
        ...filterSafeSentryIntegrations(integrations),
        reactBrowserTracing(),
      ],
    });
  }

  initialized = true;
  void syncRendererTelemetryIdentity();
}

/** Whether the renderer SDK was successfully initialised. */
export function isSentryRendererActive(): boolean {
  return initialized;
}

// ---------------------------------------------------------------------------
// Public helpers (no-op when Sentry is not configured)
// ---------------------------------------------------------------------------

/** Record a navigation breadcrumb (tab switches). */
export function addNavigationBreadcrumb(_from: string, _to: string): void {
  if (!initialized) return;
  SentryElectron.addBreadcrumb({
    category: 'navigation',
    message: 'tab-change',
    level: 'info',
  });
}

/** Record a generic breadcrumb from the renderer. */
export function addRendererBreadcrumb(
  category: string,
  message: string,
  _data?: Record<string, unknown>
): void {
  if (!initialized) return;
  SentryElectron.addBreadcrumb({ category, message, level: 'info' });
}

/** Capture an exception with optional extra context. */
export function captureRendererException(error: Error, context?: Record<string, unknown>): void {
  if (!initialized) return;
  SentryElectron.withScope((scope) => {
    const safeContext = getSafeRendererErrorContext(context);
    if (safeContext) scope.setContext('react', safeContext);
    SentryElectron.captureException(error);
  });
}
