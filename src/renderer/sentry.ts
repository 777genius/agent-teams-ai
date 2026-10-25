/**
 * Sentry initialisation for the **renderer** process.
 *
 * Must be called before `ReactDOM.createRoot()` in `main.tsx`.
 * Supports both Electron (preload bridge) and standalone browser mode.
 *
 * When `VITE_SENTRY_DSN` is not set (dev / self-builds), everything is a no-op.
 */

import {
  isMaximumUpdateDepthEvent,
  sanitizeRendererReactContext,
  sanitizeRendererUiContext,
  sanitizeSentryTabType,
} from '@renderer/utils/sentryDiagnostics';
import * as SentryElectron from '@sentry/electron/renderer';
import { browserTracingIntegration as reactBrowserTracing, init as reactInit } from '@sentry/react';
import { sentryArtifactGuardIntegration } from '@shared/utils/sentryArtifactPolicy';
import {
  filterSafeSentryIntegrations,
  isValidDsn,
  redactSentryEvent,
  SENTRY_ENVIRONMENT,
  SENTRY_RELEASE,
  TRACES_SAMPLE_RATE,
} from '@shared/utils/sentryConfig';

import { loadRendererSentryArtifactPolicy } from './sentryArtifactPolicy';

import type { ElectronAPI } from '@shared/types/api';

// ---------------------------------------------------------------------------
// Telemetry gate (mirrors src/main/sentry.ts pattern)
// ---------------------------------------------------------------------------

// Start closed until persisted config is loaded through the store.
let telemetryAllowed = false;
let initialized = false;
let telemetryIdentitySyncToken = 0;
const TELEMETRY_IDENTITY_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;
let telemetryIdentityRetryTimer: ReturnType<typeof setTimeout> | null = null;
let telemetryIdentityRetryAttempt = 0;
let rendererErrorContextGetter: (() => unknown) | null = null;

function getElectronApi(): ElectronAPI | undefined {
  return (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
}

function clearRendererSentryUser(): void {
  if (!initialized) return;
  SentryElectron.setUser?.(null);
}

function clearRendererTelemetryIdentityRetry(): void {
  if (!telemetryIdentityRetryTimer) {
    return;
  }
  clearTimeout(telemetryIdentityRetryTimer);
  telemetryIdentityRetryTimer = null;
}

function resetRendererTelemetryIdentityRetry(): void {
  clearRendererTelemetryIdentityRetry();
  telemetryIdentityRetryAttempt = 0;
}

function scheduleRendererTelemetryIdentityRetry(syncToken: number): void {
  if (!initialized || !telemetryAllowed || telemetryIdentityRetryTimer) {
    return;
  }

  const delayMs = TELEMETRY_IDENTITY_RETRY_DELAYS_MS[telemetryIdentityRetryAttempt];
  if (delayMs === undefined) {
    return;
  }
  telemetryIdentityRetryAttempt++;

  telemetryIdentityRetryTimer = setTimeout(() => {
    telemetryIdentityRetryTimer = null;
    if (syncToken === telemetryIdentitySyncToken && initialized && telemetryAllowed) {
      void syncRendererTelemetryIdentity();
    }
  }, delayMs);
}

async function syncRendererTelemetryIdentity(): Promise<void> {
  const syncToken = ++telemetryIdentitySyncToken;
  clearRendererTelemetryIdentityRetry();
  if (!initialized || !telemetryAllowed) {
    return;
  }

  const getSentryContext = getElectronApi()?.telemetry?.getSentryContext;
  if (!getSentryContext) {
    if (getElectronApi()) {
      scheduleRendererTelemetryIdentityRetry(syncToken);
    }
    return;
  }

  try {
    const context = await getSentryContext();
    if (syncToken !== telemetryIdentitySyncToken || !telemetryAllowed) {
      return;
    }

    if (!context) {
      resetRendererTelemetryIdentityRetry();
      SentryElectron.setUser?.(null);
      return;
    }

    resetRendererTelemetryIdentityRetry();
    SentryElectron.setUser?.({ id: context.userId });
    SentryElectron.setTags?.(context.tags);
  } catch {
    if (syncToken === telemetryIdentitySyncToken) {
      SentryElectron.setUser?.(null);
      scheduleRendererTelemetryIdentityRetry(syncToken);
    }
  }
}

/** The composition root supplies a read-only snapshot, avoiding a Sentry -> store import cycle. */
export function setRendererErrorContextGetter(getter: (() => unknown) | null): void {
  rendererErrorContextGetter = getter;
}

/**
 * Sync the opt-in flag from config. Call after config is loaded
 * and whenever the user toggles telemetry in Settings.
 */
export function syncRendererTelemetry(enabled: boolean): void {
  telemetryAllowed = enabled;
  if (!enabled) {
    telemetryIdentitySyncToken++;
    resetRendererTelemetryIdentityRetry();
    clearRendererSentryUser();
    return;
  }

  telemetryIdentityRetryAttempt = 0;
  initSentryRenderer();
  void syncRendererTelemetryIdentity();
}

export function initSentryRenderer(): void {
  if (initialized || !telemetryAllowed) return;

  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!isValidDsn(dsn)) return;

  const artifactPolicy = getElectronApi() ? loadRendererSentryArtifactPolicy() : null;
  const baseOptions = {
    dsn,
    release: SENTRY_RELEASE,
    environment: SENTRY_ENVIRONMENT,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-version @sentry/core type mismatch
  const beforeSend = (event: any): any => {
    if (!telemetryAllowed) return null;
    let enriched = event;
    try {
      if (rendererErrorContextGetter && isMaximumUpdateDepthEvent(event)) {
        const context = sanitizeRendererUiContext(rendererErrorContextGetter());
        if (context) enriched = { ...event, contexts: { ...event.contexts, renderer_ui: context } };
      }
    } catch {
      // Diagnostics must never suppress or replace the original exception.
    }
    return redactSentryEvent(enriched, artifactPolicy);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-version @sentry/core type mismatch
  const beforeSendTransaction = (event: any): any =>
    telemetryAllowed ? redactSentryEvent(event, artifactPolicy) : null;

  if (getElectronApi()) {
    // Electron renderer - uses IPC transport to main process.
    // browserTracingIntegration from @sentry/electron/renderer to avoid
    // @sentry/core version mismatch with @sentry/react.
    SentryElectron.init({
      ...baseOptions,
      beforeSend,
      beforeSendTransaction,
      integrations: (integrations) => [
        sentryArtifactGuardIntegration(artifactPolicy),
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
}

/** Whether the renderer SDK was successfully initialised. */
export function isSentryRendererActive(): boolean {
  return initialized;
}

// ---------------------------------------------------------------------------
// Public helpers (no-op when Sentry is not configured)
// ---------------------------------------------------------------------------

/** Record a navigation breadcrumb (tab switches). */
export function addNavigationBreadcrumb(from: string | null, to: string | null): void {
  if (!initialized || !telemetryAllowed) return;
  SentryElectron.addBreadcrumb({
    category: 'navigation',
    message: 'tab-change',
    level: 'info',
    data: { fromTabType: sanitizeSentryTabType(from), toTabType: sanitizeSentryTabType(to) },
  });
}

/** Record a generic breadcrumb from the renderer. */
export function addRendererBreadcrumb(
  category: string,
  message: string,
  _data?: Record<string, unknown>
): void {
  if (!initialized || !telemetryAllowed) return;
  SentryElectron.addBreadcrumb({ category, message, level: 'info' });
}

/** Capture an exception with optional extra context. */
export function captureRendererException(error: Error, context?: Record<string, unknown>): void {
  if (!initialized || !telemetryAllowed) return;
  SentryElectron.withScope((scope) => {
    const safeContext = sanitizeRendererReactContext(context);
    if (safeContext) scope.setContext('react', safeContext);
    SentryElectron.captureException(error);
  });
}
