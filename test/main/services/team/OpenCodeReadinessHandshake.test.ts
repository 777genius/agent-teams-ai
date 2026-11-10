import {
  createOpenCodeBridgeHandshakeIdentityHash,
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
  stableHash,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import { OpenCodeBridgeCommandHandshakePort } from '@main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { OpenCodeReadinessBridge } from '@main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { OpenCodeReadinessHandshake } from '@main/services/team/opencode/bridge/OpenCodeReadinessHandshake';
import {
  createOpenCodeCanonicalProjectPathFingerprint,
  createOpenCodeExecutionProofHash,
  createOpenCodeExpectedBehaviorFingerprint,
  openCodeReadinessArtifactKey,
} from '@main/services/team/opencode/readiness/OpenCodeExpectedBehaviorFingerprint';
import { describe, expect, it, vi } from 'vitest';

import type {
  OpenCodeBridgePeerIdentity,
  OpenCodeBridgeSuccess,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeTeamLaunchReadiness } from '@main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';

function fixture() {
  const input = {
    projectPath: '/repo',
    selectedModel: 'kimi/kimi-for-coding',
    requireExecutionProbe: true,
    effort: 'low',
    freshExecutionProofRequestId: 'run-1',
  };
  const proof = executionProofFor(input.projectPath, input.selectedModel, 'cap-1');
  const client = peerIdentity('claude_team');
  const server = peerIdentity('agent_teams_orchestrator', {
    activeRunId: null,
    runtimeStoreManifestHighWatermark: null,
  });
  const unsigned = {
    schemaVersion: 1 as const,
    requestId: 'readiness-1',
    client,
    server,
    agreedProtocolVersion: 1,
    acceptedCommands: ['opencode.launchTeam' as const],
    serverTime: new Date().toISOString(),
    expectedBehaviorFingerprint: proof.expectedBehaviorEvidence.expectedBehaviorFingerprint,
  };
  const handshake = {
    ...unsigned,
    identityHash: createOpenCodeBridgeHandshakeIdentityHash(unsigned),
  };
  const data = {
    state: 'ready',
    launchAllowed: true,
    modelId: input.selectedModel,
    executionProof: proof,
    launchHandshake: handshake,
    missing: [],
    diagnostics: [],
  } as unknown as OpenCodeTeamLaunchReadiness;
  const result = {
    ok: true,
    schemaVersion: 1,
    command: 'opencode.readiness',
    requestId: 'readiness-1',
    completedAt: new Date().toISOString(),
    durationMs: 1,
    runtime: {
      providerId: 'opencode',
      binaryPath: proof.binaryPath,
      binaryFingerprint: proof.binaryFingerprint,
      version: proof.opencodeVersion,
      capabilitySnapshotId: 'cap-1',
    },
    data,
    diagnostics: [],
  } as OpenCodeBridgeSuccess<OpenCodeTeamLaunchReadiness>;
  const launch = {
    requiredCommand: 'opencode.launchTeam' as const,
    expectedRunId: 'run-1',
    expectedCapabilitySnapshotId: 'cap-1',
    expectedManifestHighWatermark: 1,
    cwd: input.projectPath,
    selectedModel: input.selectedModel,
    effort: input.effort,
    toolApprovalMode: 'auto' as const,
    expectedBehaviorFingerprint: unsigned.expectedBehaviorFingerprint,
    executionProofIdentity: stableHash(proof),
  };
  return { input, client, result, handshake, launch };
}
describe('composition-owned readiness handshake admission', () => {
  it('uses the validated inline response once, then retains legacy negotiation', async () => {
    const f = fixture();
    const admission = new OpenCodeReadinessHandshake(f.client);
    const execute = vi.fn().mockResolvedValue(f.result);
    const readiness = new OpenCodeReadinessBridge({ execute } as never, {
      readinessHandshake: admission,
    });
    await readiness.checkOpenCodeTeamLaunchReadiness(f.input);
    expect(execute.mock.calls[0][1]).toMatchObject({ ...f.input, client: f.client });
    const fallback = vi.fn().mockResolvedValue({ ...f.result, data: f.handshake });
    const port = new OpenCodeBridgeCommandHandshakePort({
      bridge: { execute: fallback } as never,
      clientIdentity: f.client,
      readinessHandshake: admission,
    });
    expect(await port.handshake(f.launch)).toEqual(f.handshake);
    expect(fallback).not.toHaveBeenCalled();
    await port.handshake(f.launch);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][1]).toMatchObject({ effort: 'low' });
    expect(fallback.mock.calls[0][1]).not.toHaveProperty('executionProofIdentity');
  });
  it.each(['request', 'client', 'binary', 'behavior'] as const)(
    'refuses mismatched %s evidence',
    (mismatch) => {
      const f = fixture();
      const admission = new OpenCodeReadinessHandshake(f.client);
      if (mismatch === 'request') f.handshake.requestId = 'other';
      if (mismatch === 'client') f.handshake.client.buildId = 'other';
      if (mismatch === 'binary') f.result.runtime.binaryFingerprint = 'other';
      if (mismatch === 'behavior') f.handshake.expectedBehaviorFingerprint = 'other';
      expect(() => admission.remember(f.input, f.result)).toThrow();
    }
  );
  it('binds the exact proof and consumes before refusal', () => {
    const f = fixture();
    const admission = new OpenCodeReadinessHandshake(f.client);
    admission.remember(f.input, f.result);
    expect(() => admission.take({ ...f.launch, executionProofIdentity: 'other' })).toThrow(
      /binding mismatch/
    );
    expect(admission.take(f.launch)).toBeNull();
  });
  it('keeps normal UI and different effort admissions separate from forced run admission', () => {
    const f = fixture();
    const admission = new OpenCodeReadinessHandshake(f.client);
    admission.remember(f.input, f.result);
    admission.remember({ ...f.input, freshExecutionProofRequestId: undefined }, f.result);
    admission.remember({ ...f.input, effort: 'high' }, f.result);
    expect(admission.take(f.launch)).toEqual(f.handshake);
    expect(openCodeReadinessArtifactKey(f.input)).not.toEqual(
      openCodeReadinessArtifactKey({ ...f.input, effort: 'high' })
    );
  });
  it('rejects proof expiry at consumption without altering TTL', () => {
    const f = fixture();
    const admission = new OpenCodeReadinessHandshake(f.client);
    admission.remember(f.input, f.result);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      expect(() => admission.take(f.launch)).toThrow(/stale/);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not admit absent inline handshakes (V1 fallback)', () => {
    const f = fixture();
    delete (f.result.data as unknown as { launchHandshake?: unknown }).launchHandshake;
    const admission = new OpenCodeReadinessHandshake(f.client);
    admission.remember(f.input, f.result);
    expect(admission.take(f.launch)).toBeNull();
  });
});
function peerIdentity(
  peer: OpenCodeBridgePeerIdentity['peer'],
  runtimeOverrides: Partial<OpenCodeBridgePeerIdentity['runtime']> = {}
): OpenCodeBridgePeerIdentity {
  return {
    schemaVersion: 1,
    peer,
    appVersion: '1.0.0',
    gitSha: 'git-1',
    buildId: 'build-1',
    bridgeProtocol: {
      minVersion: 1,
      currentVersion: 1,
      supportedCommands: [
        'opencode.handshake',
        'opencode.commandStatus',
        'opencode.launchTeam',
        'opencode.stopTeam',
      ],
      opencodeAppManagedBootstrapContractVersion: OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
      expectedBehaviorFingerprintSchemaVersion:
        OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
    },
    runtime: {
      providerId: 'opencode',
      binaryPath: '/opt/homebrew/bin/opencode',
      binaryFingerprint: 'binary-v1',
      version: '1.14.19',
      capabilitySnapshotId: 'cap-1',
      runtimeStoreManifestHighWatermark: 10,
      activeRunId: 'run-1',
      ...runtimeOverrides,
    },
    featureFlags: {
      opencodeTeamLaunch: true,
      opencodeStateChangingCommands: true,
    },
  };
}

function executionProofFor(
  projectPath: string,
  fullModelId: string,
  capabilitySnapshotId = 'cap-proof'
) {
  const tuple = expectedBehaviorTuple(projectPath, fullModelId);
  const unsigned = {
    schemaVersion: 1 as const,
    providerId: 'opencode' as const,
    modelId: fullModelId,
    projectPath,
    profileRootKey: 'profile-root',
    projectBehaviorFingerprint: tuple.projectBehaviorFingerprint,
    managedConfigFingerprint: 'config-v1',
    managedAuthFingerprint: 'auth-v1',
    binaryPath: '/opt/homebrew/bin/opencode',
    binaryFingerprint: 'binary-v1',
    opencodeVersion: '1.14.19',
    capabilitySnapshotId,
    credentialMode: 'api' as const,
    reusable: true,
    verifiedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
    expectedBehaviorEvidence: {
      ...tuple,
      expectedBehaviorFingerprint: createOpenCodeExpectedBehaviorFingerprint(tuple),
    },
  };
  return { ...unsigned, proofHash: createOpenCodeExecutionProofHash(unsigned) };
}

function expectedBehaviorTuple(projectPath: string, fullModelId: string) {
  return {
    canonicalProjectPathFingerprint: createOpenCodeCanonicalProjectPathFingerprint(projectPath),
    modelProviderId: fullModelId.slice(0, fullModelId.indexOf('/')).toLowerCase(),
    fullModelId,
    projectBehaviorFingerprint: 'c'.repeat(64),
    effectiveConfigFingerprint: 'd'.repeat(64),
    effectiveSelectedAuthFingerprint: 'e'.repeat(64),
  };
}
