import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeBridgeHandshakeIdentityHash,
  type OpenCodeBridgeHandshake,
  type OpenCodeBridgePeerIdentity,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import { createOpenCodeBridgeClientIdentity } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { OpenCodeStrictLaunchDelegationPreflight } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStrictLaunchDelegationPreflight';

import type { OpenCodeBridgeHandshakePort } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';

describe('OpenCodeStrictLaunchDelegationPreflight', () => {
  it('uses a snapshot-free lightweight launchTeam handshake', async () => {
    const client = createOpenCodeBridgeClientIdentity({ appVersion: '1.0.0' });
    const server = createServerIdentity(client);
    server.runtime.capabilitySnapshotId = 'live-capability-snapshot-that-must-be-ignored';
    server.runtime.runtimeStoreManifestHighWatermark = 42;
    delete server.bridgeProtocol.opencodeAppManagedBootstrapContractVersion;
    const handshake = vi.fn().mockResolvedValue(buildHandshake(client, server));
    const preflight = new OpenCodeStrictLaunchDelegationPreflight(
      { handshake } as OpenCodeBridgeHandshakePort,
      client
    );

    await expect(preflight.validate({ cwd: '/fake/project' })).resolves.toEqual({
      ok: true,
      contractVersion: 1,
    });
    expect(handshake).toHaveBeenCalledExactlyOnceWith({
      requiredCommand: 'opencode.launchTeam',
      expectedRunId: null,
      expectedCapabilitySnapshotId: null,
      expectedManifestHighWatermark: null,
      cwd: '/fake/project',
    });
  });

  it.each([
    {
      kind: 'accepted command',
      configure(handshake: OpenCodeBridgeHandshake) {
        handshake.acceptedCommands = ['opencode.handshake'];
      },
      reason: 'does not accept command opencode.launchTeam',
    },
    {
      kind: 'supported command',
      configure(handshake: OpenCodeBridgeHandshake) {
        handshake.server.bridgeProtocol.supportedCommands = ['opencode.handshake'];
      },
      reason: 'does not support command opencode.launchTeam',
    },
    {
      kind: 'launch attempt contract',
      configure(handshake: OpenCodeBridgeHandshake) {
        handshake.server.bridgeProtocol.openCodeLaunchAttemptContract = 0;
      },
      reason: 'openCodeLaunchAttemptContract 1',
    },
    {
      kind: 'request correlation contract',
      configure(handshake: OpenCodeBridgeHandshake) {
        handshake.server.bridgeProtocol.openCodeLaunchRequestCorrelationContract = 0;
      },
      reason: 'openCodeLaunchRequestCorrelationContract 1',
    },
  ])('requires the orchestrator $kind', async ({ configure, reason }) => {
    const client = createOpenCodeBridgeClientIdentity({ appVersion: '1.0.0' });
    const bridgeHandshake = buildHandshake(client, createServerIdentity(client));
    configure(bridgeHandshake);
    bridgeHandshake.identityHash = createOpenCodeBridgeHandshakeIdentityHash(bridgeHandshake);
    const preflight = new OpenCodeStrictLaunchDelegationPreflight(
      { handshake: vi.fn().mockResolvedValue(bridgeHandshake) },
      client
    );

    await expect(preflight.validate({ cwd: '/fake/project' })).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining(reason),
    });
  });
});

function createServerIdentity(
  client: OpenCodeBridgePeerIdentity
): OpenCodeBridgePeerIdentity {
  return {
    ...structuredClone(client),
    peer: 'agent_teams_orchestrator',
  };
}

function buildHandshake(
  client: OpenCodeBridgePeerIdentity,
  server: OpenCodeBridgePeerIdentity
): OpenCodeBridgeHandshake {
  const withoutHash: Omit<OpenCodeBridgeHandshake, 'identityHash'> = {
    schemaVersion: 1,
    requestId: 'handshake-1',
    client,
    server,
    agreedProtocolVersion: 1,
    acceptedCommands: ['opencode.handshake', 'opencode.launchTeam'],
    serverTime: '2026-08-24T00:00:00.000Z',
  };
  return {
    ...withoutHash,
    identityHash: createOpenCodeBridgeHandshakeIdentityHash(withoutHash),
  };
}
