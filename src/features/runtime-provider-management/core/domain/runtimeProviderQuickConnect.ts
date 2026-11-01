import { isOpenCodeVersionServedByRuntime } from '@features/opencode-compatibility';
import { isRecognizedOpenCodeV2Version } from '@shared/utils/version';

import type { RuntimeProviderDirectoryEntryDto } from '../../contracts';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

export type RuntimeProviderQuickConnectGate =
  | 'checking'
  | 'installing'
  | 'ready'
  | 'support-required'
  | 'missing'
  | 'error';

export type RuntimeProviderQuickPlanState =
  | 'checking'
  | 'connected'
  | 'connectable'
  | 'different-credential'
  | 'manual'
  | 'unavailable'
  | 'update-required';

const MINIMUM_OPENCODE_PROVIDER_OAUTH_VERSION = [1, 15, 7] as const;

/** A managed install or update cannot change the binary that a binary override selects. */
export function canManagedInstallChangeOpenCodeRuntime(
  runtimeStatus: OpenCodeRuntimeStatus | null
): boolean {
  return runtimeStatus?.source !== 'override';
}

export function isOpenCodeRuntimeUsable(runtimeStatus: OpenCodeRuntimeStatus | null): boolean {
  return (
    runtimeStatus?.installed === true &&
    runtimeStatus.v2Support !== 'required' &&
    isOpenCodeVersionServedByRuntime(runtimeStatus.version)
  );
}

export function isOpenCodeProviderOAuthBridgeOutdated(
  openCodeRuntimeStatus: OpenCodeRuntimeStatus | null
): boolean {
  if (!openCodeRuntimeStatus?.installed || !openCodeRuntimeStatus.version) {
    return false;
  }
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/.exec(openCodeRuntimeStatus.version);
  if (!match) {
    return false;
  }
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < version.length; index += 1) {
    const difference = version[index] - MINIMUM_OPENCODE_PROVIDER_OAUTH_VERSION[index];
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

export function resolveOpenCodeQuickConnectGate(input: {
  runtimeStatus: OpenCodeRuntimeStatus | null;
  runtimeStatusLoading: boolean;
  provider: CliProviderStatus | null;
  cliStatusLoading: boolean;
}): RuntimeProviderQuickConnectGate {
  const { runtimeStatus } = input;
  // Preserve concrete installation progress and a usable existing runtime during refresh.
  if (runtimeStatus?.state === 'downloading' || runtimeStatus?.state === 'installing') {
    return 'installing';
  }
  if (
    (runtimeStatus?.state === 'ready' || runtimeStatus?.state === 'failed') &&
    isOpenCodeRuntimeUsable(runtimeStatus)
  ) {
    return 'ready';
  }
  if (input.runtimeStatusLoading || runtimeStatus?.state === 'checking' || runtimeStatus === null) {
    return 'checking';
  }
  if (runtimeStatus.state === 'failed') return 'error';
  if (
    runtimeStatus.installed &&
    runtimeStatus.v2Support === 'required' &&
    isRecognizedOpenCodeV2Version(runtimeStatus.version)
  ) {
    return 'support-required';
  }
  if (isOpenCodeRuntimeUsable(runtimeStatus)) {
    return 'ready';
  }
  // Credentials/provider availability cannot prove that a supported local binary exists.
  return 'missing';
}

/**
 * Identifies the OpenCode runtime a provider directory read belongs to.
 *
 * Returns null while the runtime is unknown, checking or installing, so callers
 * keep the last settled identity instead of treating every progress event as a
 * change. A different settled identity (missing -> ready after an install, a new
 * version or binary after an update) means earlier directory reads describe
 * another runtime and must not be reused.
 */
export function resolveOpenCodeQuickConnectRuntimeRevision(input: {
  gate: RuntimeProviderQuickConnectGate;
  runtimeStatus: OpenCodeRuntimeStatus | null;
}): string | null {
  const { gate, runtimeStatus } = input;
  if (!runtimeStatus || gate === 'checking' || gate === 'installing') {
    return null;
  }
  if (gate !== 'ready') {
    return 'unavailable';
  }
  return JSON.stringify(['ready', runtimeStatus.version ?? null, runtimeStatus.binaryPath ?? null]);
}

export function isOAuthCredentialHint(authHint: string | null | undefined): boolean {
  return Boolean(authHint && /(oauth|subscription|account|chatgpt|supergrok)/i.test(authHint));
}

export function resolveOpenCodeQuickPlanState(input: {
  entry: RuntimeProviderDirectoryEntryDto | null;
  requiresOAuthCredential?: boolean;
  oauthBridgeOutdated?: boolean;
}): RuntimeProviderQuickPlanState {
  const { entry } = input;
  const connectedWithOAuth =
    entry?.state === 'connected' && isOAuthCredentialHint(entry.connectedAuthHint);

  if (input.oauthBridgeOutdated && !connectedWithOAuth) {
    return 'update-required';
  }
  if (!entry) {
    return 'unavailable';
  }
  if (entry.state === 'connected') {
    if (input.requiresOAuthCredential && !connectedWithOAuth) {
      return 'different-credential';
    }
    return 'connected';
  }
  if (entry.setupKind === 'connect-api-key' || entry.setupKind === 'connect-oauth') {
    return 'connectable';
  }
  if (
    entry.setupKind === 'configure-manually' ||
    entry.setupKind === 'requires-environment' ||
    entry.setupKind === 'available-readonly'
  ) {
    return 'manual';
  }
  return 'unavailable';
}
