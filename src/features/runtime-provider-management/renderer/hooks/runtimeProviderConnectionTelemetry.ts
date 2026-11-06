import {
  classifyAnalyticsError,
  elapsedMsSince,
  recordProviderConnectionEnd,
} from '@renderer/analytics/productAnalytics';

import { isProviderConnectCancellation } from './runtimeProviderManagementInternals';

import type {
  RuntimeProviderManagementRuntimeId,
  RuntimeProviderSetupMethodDto,
} from '../../contracts';
import type { AnalyticsProviderConnectionIntent } from '@renderer/analytics/productAnalytics';

/** Preserve the existing cancellation classification and connection telemetry around the original request. */
export function recordRuntimeProviderConnectFailure(input: {
  readonly error: unknown;
  readonly runtime: RuntimeProviderManagementRuntimeId;
  readonly provider: string;
  readonly method: RuntimeProviderSetupMethodDto;
  readonly previouslyCancelled: boolean;
  readonly intent: AnalyticsProviderConnectionIntent;
  readonly startedAtMs: number;
}): boolean {
  const cancelled =
    input.method === 'oauth' &&
    (input.previouslyCancelled || isProviderConnectCancellation(input.error));
  recordProviderConnectionEnd({
    runtime: input.runtime,
    provider: input.provider,
    authMethod: input.method,
    connectionIntent: input.intent,
    outcome: cancelled ? 'cancelled' : 'failed',
    errorClass: cancelled
      ? 'none'
      : input.error == null
        ? 'unknown'
        : classifyAnalyticsError(input.error),
    durationMs: elapsedMsSince(input.startedAtMs),
  });
  return cancelled;
}

export function recordRuntimeProviderConnectSuccess(input: {
  readonly runtime: RuntimeProviderManagementRuntimeId;
  readonly provider: string;
  readonly method: RuntimeProviderSetupMethodDto;
  readonly intent: AnalyticsProviderConnectionIntent;
  readonly startedAtMs: number;
  readonly verifiedModelId: string | null | undefined;
}): void {
  recordProviderConnectionEnd({
    runtime: input.runtime,
    provider: input.provider,
    authMethod: input.method,
    connectionIntent: input.intent,
    outcome: input.verifiedModelId ? 'verified' : 'connected_unverified',
    errorClass: 'none',
    durationMs: elapsedMsSince(input.startedAtMs),
  });
}
