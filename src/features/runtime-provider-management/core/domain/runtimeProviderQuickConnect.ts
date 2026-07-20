import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import { isAgentTeamsOpenCodeVersionSupported } from '@shared/utils/version';

import type { RuntimeProviderDirectoryEntryDto } from '../../contracts';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

export type RuntimeProviderQuickConnectGate =
  | 'checking'
  | 'installing'
  | 'ready'
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

export function isOpenCodeRuntimeUsable(runtimeStatus: OpenCodeRuntimeStatus | null): boolean {
  return (
    runtimeStatus?.installed === true && isAgentTeamsOpenCodeVersionSupported(runtimeStatus.version)
  );
}

function isProviderCheckPending(provider: CliProviderStatus | null): boolean {
  return Boolean(
    provider &&
    !provider.authenticated &&
    (provider.statusMessage === 'Checking...' ||
      provider.statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE)
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
  // A concrete installer state is more authoritative than the generic request flag.
  // `runtimeStatusLoading` remains true while install IPC is pending, including while
  // progress events report downloading/installing or the request has already failed.
  if (runtimeStatus?.state === 'downloading' || runtimeStatus?.state === 'installing') {
    return 'installing';
  }
  if (runtimeStatus?.state === 'failed') {
    return isOpenCodeRuntimeUsable(runtimeStatus) ? 'ready' : 'error';
  }
  if (runtimeStatus?.state === 'ready' && isOpenCodeRuntimeUsable(runtimeStatus)) {
    return 'ready';
  }
  if (
    input.runtimeStatusLoading ||
    runtimeStatus?.state === 'checking' ||
    (runtimeStatus === null && (input.cliStatusLoading || isProviderCheckPending(input.provider)))
  ) {
    return 'checking';
  }
  if (isOpenCodeRuntimeUsable(runtimeStatus)) {
    return 'ready';
  }
  if (
    runtimeStatus === null &&
    input.provider?.supported === true &&
    input.provider.authenticated &&
    input.provider.capabilities.teamLaunch
  ) {
    return 'ready';
  }
  return 'missing';
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
