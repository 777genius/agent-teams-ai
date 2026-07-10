/**
 * PostHog initialisation for the renderer process.
 *
 * The SDK is build-time configured and stays disabled unless POSTHOG_KEY
 * or VITE_POSTHOG_KEY is provided for the renderer bundle.
 */

import {
  APP_NAME,
  APP_NAMESPACE,
  APP_VERSION,
  BUILD_ID,
  getSharedTelemetryBuildProperties,
} from '@shared/utils/buildMetadata';
import posthog from 'posthog-js';

import type { ElectronAPI } from '@shared/types/api';
import type { PostHogConfig, Properties } from 'posthog-js';

const DEFAULT_POSTHOG_EU_HOST = 'https://eu.i.posthog.com';
const POSTHOG_IDENTIFY_EVENT = '$identify';
const POSTHOG_SET_EVENT = '$set';
const POSTHOG_APP_SESSION_START_EVENT = 'app:session_start';
const POSTHOG_PERSISTENCE_NAME = 'agent_teams_posthog_identity_v1';
const POSTHOG_APP_SESSION_START_PROPERTIES: Properties = {
  surface: 'renderer',
};

let telemetryAllowed = false;
let initialized = false;
let identityReady = false;
let identitySyncDistinctId: string | null = null;
let postHogIdentityNeedsRestore = false;
let identitySyncToken = 0;
let appSessionStartCaptured = false;

type PostHogIdentityContext = {
  userId: string;
  tags: Record<string, string>;
};

function getElectronApi(): ElectronAPI | undefined {
  return (window as Window & { electronAPI?: ElectronAPI }).electronAPI;
}

function normalizeEnvValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getPostHogKey(): string {
  return normalizeEnvValue(import.meta.env.VITE_POSTHOG_KEY);
}

function getPostHogHost(): string {
  return normalizeEnvValue(import.meta.env.VITE_POSTHOG_HOST) || DEFAULT_POSTHOG_EU_HOST;
}

function resetPostHogIdentity(): void {
  if (!initialized) return;
  posthog.reset(false);
  postHogIdentityNeedsRestore = true;
  posthog.opt_out_capturing();
}

function pausePostHogCapturing(): void {
  if (!initialized) return;
  posthog.opt_out_capturing();
}

function getPostHogAppProperties(contextTags?: Record<string, string>): Properties {
  const properties: Properties = {
    ...contextTags,
    ...getSharedTelemetryBuildProperties(),
    $app_name: APP_NAME,
    $app_namespace: APP_NAMESPACE,
    $app_version: APP_VERSION,
  };

  if (BUILD_ID) {
    properties.$app_build = BUILD_ID;
  }

  return properties;
}

function isPostHogIdentityEventForCurrentSync(event: { properties?: Properties }): boolean {
  return (
    typeof event.properties?.distinct_id === 'string' &&
    event.properties.distinct_id === identitySyncDistinctId
  );
}

function restorePostHogStableDistinctId(distinctId: string): void {
  if (!initialized) return;

  if (!postHogIdentityNeedsRestore && posthog.get_distinct_id() === distinctId) {
    return;
  }

  if (posthog.get_distinct_id() !== distinctId) {
    posthog.reset(false);
    posthog.opt_out_capturing();
  }

  posthog.identify(distinctId);
  postHogIdentityNeedsRestore = false;
  posthog.opt_out_capturing();
}

async function syncPostHogIdentity(): Promise<void> {
  const syncToken = ++identitySyncToken;
  if (!telemetryAllowed) {
    return;
  }

  const getTelemetryContext = getElectronApi()?.telemetry?.getSentryContext;
  if (!getTelemetryContext) {
    identityReady = false;
    identitySyncDistinctId = null;
    pausePostHogCapturing();
    return;
  }

  try {
    const context = await getTelemetryContext();
    if (syncToken !== identitySyncToken || !telemetryAllowed) {
      return;
    }

    if (!context) {
      identityReady = false;
      identitySyncDistinctId = null;
      pausePostHogCapturing();
      return;
    }

    const appProperties = getPostHogAppProperties(context.tags);
    identitySyncDistinctId = context.userId;
    initPostHogRenderer(context);
    if (!initialized) {
      return;
    }

    restorePostHogStableDistinctId(context.userId);

    posthog.opt_in_capturing({ captureEventName: false });
    posthog.setPersonProperties(appProperties);
    posthog.register(appProperties);
    identityReady = true;
    capturePostHogEvent(POSTHOG_APP_SESSION_START_EVENT, POSTHOG_APP_SESSION_START_PROPERTIES);
  } catch {
    if (syncToken === identitySyncToken) {
      identityReady = false;
      identitySyncDistinctId = null;
      pausePostHogCapturing();
    }
  }
}

export function initPostHogRenderer(identityContext?: PostHogIdentityContext): void {
  if (initialized || !telemetryAllowed) return;
  if (!identityContext) return;

  const apiKey = getPostHogKey();
  if (!apiKey) return;

  const options: Partial<PostHogConfig> = {
    api_host: getPostHogHost(),
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    capture_dead_clicks: false,
    disable_external_dependency_loading: true,
    disable_product_tours: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_session_recording: true,
    opt_out_capturing_by_default: true,
    bootstrap: {
      distinctID: identityContext.userId,
      isIdentifiedID: true,
    },
    persistence: 'localStorage+cookie',
    persistence_name: POSTHOG_PERSISTENCE_NAME,
    person_profiles: 'identified_only',
    before_send: (event) => {
      if (!event) {
        return null;
      }

      if (event.event === POSTHOG_IDENTIFY_EVENT) {
        return null;
      }

      if (
        identityReady ||
        (event.event === POSTHOG_SET_EVENT && isPostHogIdentityEventForCurrentSync(event))
      ) {
        return event;
      }

      return null;
    },
    loaded: (client) => {
      if (import.meta.env.DEV) {
        client.debug();
      }
    },
  };

  posthog.init(apiKey, options);
  initialized = true;
  pausePostHogCapturing();
  restorePostHogStableDistinctId(identityContext.userId);
  posthog.register(getPostHogAppProperties(identityContext.tags));
}

export function syncPostHogTelemetry(enabled: boolean): void {
  telemetryAllowed = enabled;
  if (!enabled) {
    identitySyncToken++;
    identityReady = false;
    identitySyncDistinctId = null;
    appSessionStartCaptured = false;
    if (initialized) {
      resetPostHogIdentity();
    }
    return;
  }

  void syncPostHogIdentity();
}

export function capturePostHogEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (!initialized || !telemetryAllowed) return;
  if (!identityReady) return;
  if (eventName === POSTHOG_APP_SESSION_START_EVENT) {
    if (appSessionStartCaptured) return;
    appSessionStartCaptured = true;
  }

  posthog.capture(eventName, properties);
}

export function isPostHogRendererActive(): boolean {
  return initialized;
}
