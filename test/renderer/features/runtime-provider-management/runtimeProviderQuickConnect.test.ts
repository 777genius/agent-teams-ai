import { describe, expect, it } from 'vitest';

import {
  isOpenCodeProviderOAuthBridgeOutdated,
  resolveOpenCodeQuickConnectGate,
  resolveOpenCodeQuickPlanState,
} from '../../../../src/features/runtime-provider-management/core/domain/runtimeProviderQuickConnect';

import type { RuntimeProviderDirectoryEntryDto } from '../../../../src/features/runtime-provider-management/contracts';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '../../../../src/shared/types';

function runtimeStatus(overrides: Partial<OpenCodeRuntimeStatus> = {}): OpenCodeRuntimeStatus {
  return {
    installed: true,
    version: '1.15.7',
    source: 'app-managed',
    state: 'ready',
    ...overrides,
  };
}

function provider(overrides: Partial<CliProviderStatus> = {}): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'local',
    verificationState: 'verified',
    models: [],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'supported', ownership: 'shared' },
        mcp: { status: 'supported', ownership: 'shared' },
        skills: { status: 'supported', ownership: 'shared' },
        apiKeys: { status: 'supported', ownership: 'shared' },
      },
    },
    ...overrides,
  };
}

function directoryEntry(
  overrides: Partial<RuntimeProviderDirectoryEntryDto> = {}
): RuntimeProviderDirectoryEntryDto {
  return {
    providerId: 'xai',
    displayName: 'xAI',
    state: 'connected',
    connectedAuthHint: 'oauth',
    setupKind: 'connected',
    ownership: ['managed'],
    recommended: false,
    modelCount: 3,
    authMethods: ['oauth'],
    defaultModelId: null,
    sources: ['inventory'],
    sourceLabel: 'OpenCode inventory',
    providerSource: null,
    detail: null,
    actions: [],
    metadata: {
      hasKnownModels: true,
      requiresManualConfig: false,
      supportedInlineAuth: true,
      configuredAuthless: false,
    },
    ...overrides,
  };
}

describe('runtimeProviderQuickConnect domain policy', () => {
  it('compares OpenCode versions without treating newer minor versions as outdated', () => {
    expect(isOpenCodeProviderOAuthBridgeOutdated(runtimeStatus({ version: '1.15.6' }))).toBe(true);
    expect(isOpenCodeProviderOAuthBridgeOutdated(runtimeStatus({ version: '1.15.7' }))).toBe(false);
    expect(isOpenCodeProviderOAuthBridgeOutdated(runtimeStatus({ version: '1.16.0' }))).toBe(false);
    expect(isOpenCodeProviderOAuthBridgeOutdated(runtimeStatus({ version: '2.0.0' }))).toBe(false);
  });

  it('keeps runtime checking, installing, failed, missing, and ready states distinct', () => {
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: null,
        runtimeStatusLoading: true,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('checking');
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: runtimeStatus({ state: 'installing' }),
        runtimeStatusLoading: false,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('installing');
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: runtimeStatus({ state: 'failed', error: 'broken' }),
        runtimeStatusLoading: false,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('error');
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: runtimeStatus({ installed: false, state: 'idle' }),
        runtimeStatusLoading: false,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('missing');
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: null,
        runtimeStatusLoading: false,
        provider: provider(),
        cliStatusLoading: false,
      })
    ).toBe('ready');
  });

  it('only reports SuperGrok connected when the saved credential is OAuth', () => {
    expect(
      resolveOpenCodeQuickPlanState({
        entry: directoryEntry({ connectedAuthHint: 'oauth' }),
        requiresOAuthCredential: true,
      })
    ).toBe('connected');
    expect(
      resolveOpenCodeQuickPlanState({
        entry: directoryEntry({ connectedAuthHint: 'api' }),
        requiresOAuthCredential: true,
      })
    ).toBe('different-credential');
    expect(
      resolveOpenCodeQuickPlanState({
        entry: directoryEntry({ connectedAuthHint: undefined }),
        requiresOAuthCredential: true,
      })
    ).toBe('different-credential');
  });

  it('requires an OpenCode update for SuperGrok unless OAuth is already connected', () => {
    expect(
      resolveOpenCodeQuickPlanState({
        entry: directoryEntry({ connectedAuthHint: 'api' }),
        requiresOAuthCredential: true,
        oauthBridgeOutdated: true,
      })
    ).toBe('update-required');
    expect(
      resolveOpenCodeQuickPlanState({
        entry: directoryEntry({ connectedAuthHint: 'oauth' }),
        requiresOAuthCredential: true,
        oauthBridgeOutdated: true,
      })
    ).toBe('connected');
  });

  it('maps connectable, manual, and absent providers without inventing connectivity', () => {
    expect(
      resolveOpenCodeQuickPlanState({
        entry: directoryEntry({ state: 'available', setupKind: 'connect-api-key' }),
      })
    ).toBe('connectable');
    expect(
      resolveOpenCodeQuickPlanState({
        entry: directoryEntry({ state: 'available', setupKind: 'configure-manually' }),
      })
    ).toBe('manual');
    expect(resolveOpenCodeQuickPlanState({ entry: null })).toBe('unavailable');
  });
});
