import { describe, expect, it } from 'vitest';

import { mergeCodexCliStatusWithSnapshot } from '../../../../src/features/codex-account/renderer/mergeCodexCliStatusWithSnapshot';
import { createDefaultCliExtensionCapabilities } from '../../../../src/shared/utils/providerExtensionCapabilities';

import type { CodexAccountSnapshotDto } from '../../../../src/features/codex-account/contracts';
import type { CliInstallationStatus } from '../../../../src/shared/types';

function createCliStatus(): CliInstallationStatus {
  return {
    flavor: 'agent_teams_orchestrator',
    displayName: 'Multimodel runtime',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: true,
    installed: true,
    installedVersion: '0.0.3',
    binaryPath: '/usr/local/bin/agent-teams',
    launchError: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: true,
    authStatusChecking: false,
    authMethod: null,
    providers: [
      {
        providerId: 'anthropic',
        displayName: 'Anthropic',
        supported: true,
        authenticated: true,
        authMethod: 'oauth',
        verificationState: 'verified',
        modelVerificationState: 'verified',
        statusMessage: 'Connected',
        models: ['claude-opus-4-7'],
        modelAvailability: [],
        canLoginFromUi: true,
        capabilities: {
          teamLaunch: true,
          oneShot: true,
          extensions: createDefaultCliExtensionCapabilities(),
        },
        selectedBackendId: null,
        resolvedBackendId: null,
        availableBackends: [],
        externalRuntimeDiagnostics: [],
        backend: null,
        connection: null,
      },
      {
        providerId: 'codex',
        displayName: 'Codex',
        supported: true,
        authenticated: false,
        authMethod: null,
        verificationState: 'unknown',
        modelVerificationState: 'idle',
        statusMessage: 'Checking...',
        models: ['gpt-5.4', 'gpt-5.1-codex-max'],
        modelAvailability: [],
        canLoginFromUi: true,
        capabilities: {
          teamLaunch: true,
          oneShot: true,
          extensions: createDefaultCliExtensionCapabilities(),
        },
        selectedBackendId: 'codex-native',
        resolvedBackendId: null,
        availableBackends: [],
        externalRuntimeDiagnostics: [],
        backend: null,
        connection: null,
      },
    ],
  };
}

function createChatgptSnapshot(): CodexAccountSnapshotDto {
  return {
    preferredAuthMode: 'chatgpt',
    effectiveAuthMode: 'chatgpt',
    launchAllowed: true,
    launchIssueMessage: null,
    launchReadinessState: 'ready_chatgpt',
    appServerState: 'healthy',
    appServerStatusMessage: null,
    managedAccount: {
      type: 'chatgpt',
      email: 'user@example.com',
      planType: 'pro',
    },
    apiKey: {
      available: false,
      source: null,
      sourceLabel: null,
    },
    requiresOpenaiAuth: false,
    localAccountArtifactsPresent: false,
    login: {
      status: 'idle',
      error: null,
      startedAt: null,
    },
    rateLimits: null,
    updatedAt: '2026-04-20T12:00:00.000Z',
  };
}

describe('mergeCodexCliStatusWithSnapshot', () => {
  it('updates only the codex provider while preserving the rest of the runtime status', () => {
    const merged = mergeCodexCliStatusWithSnapshot(createCliStatus(), createChatgptSnapshot());

    expect(merged?.providers[0]?.providerId).toBe('anthropic');
    expect(merged?.providers[0]?.statusMessage).toBe('Connected');
    expect(merged?.providers[1]?.providerId).toBe('codex');
    expect(merged?.providers[1]?.authMethod).toBe('chatgpt');
    expect(merged?.providers[1]?.statusMessage).toBe('ChatGPT account ready');
    expect(merged?.providers[1]?.backend?.authMethodDetail).toBe('chatgpt');
    expect(merged?.providers[1]?.models).toEqual(['gpt-5.4', 'gpt-5.1-codex-max']);
  });
});
