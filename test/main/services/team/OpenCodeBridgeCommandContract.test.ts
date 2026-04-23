import { describe, expect, it } from 'vitest';

import {
  assertBridgeEvidenceCanCommitToRuntimeStores,
  assertBridgeResultCanMutateState,
  createOpenCodeBridgeHandshakeIdentityHash,
  createOpenCodeBridgeIdempotencyKey,
  parseSingleBridgeJsonResult,
  stableHash,
  validateBridgeResultEnvelope,
  validateOpenCodeBridgeHandshake,
  type OpenCodeBridgeCommandEnvelope,
  type OpenCodeBridgeHandshake,
  type OpenCodeBridgePeerIdentity,
  type OpenCodeBridgeRuntimeSnapshot,
  type OpenCodeBridgeSuccess,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

describe('OpenCodeBridgeCommandContract', () => {
  it('rejects bridge stdout with logs plus json', () => {
    const result = parseSingleBridgeJsonResult('debug log\n{"ok":true}\n');

    expect(result).toEqual({
      ok: false,
      error: 'Bridge stdout must contain exactly one JSON line, got 2',
    });
  });

  it('parses exactly one bridge result JSON line', () => {
    const stdout = `${JSON.stringify(
      bridgeSuccess({
        data: {
          runId: 'run-1',
          idempotencyKey: 'key-1',
          runtimeStoreManifestHighWatermark: 10,
        },
      })
    )}\n`;

    const parsed = parseSingleBridgeJsonResult(stdout);

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        ok: true,
        requestId: 'req-1',
        command: 'opencode.launchTeam',
      },
    });
  });

  it('validates result request id and command against the command envelope', () => {
    const envelope: OpenCodeBridgeCommandEnvelope<Record<string, never>> = {
      schemaVersion: 1,
      requestId: 'req-expected',
      command: 'opencode.launchTeam',
      cwd: '/tmp/project',
      startedAt: '2026-04-21T12:00:00.000Z',
      timeoutMs: 10_000,
      body: {},
    };

    expect(validateBridgeResultEnvelope(bridgeSuccess({ requestId: 'other' }), envelope)).toEqual({
      ok: false,
      reason: 'OpenCode bridge requestId mismatch',
    });

    expect(
      validateBridgeResultEnvelope(
        bridgeSuccess({ requestId: 'req-expected', command: 'opencode.stopTeam' }),
        envelope
      )
    ).toEqual({
      ok: false,
      reason: 'OpenCode bridge command mismatch',
    });
  });

  it('does not allow state mutation when capability snapshot mismatches', () => {
    const result = bridgeSuccess({
      runtime: { capabilitySnapshotId: 'old-snapshot' },
      data: { runId: 'run-1' },
    });

    expect(() =>
      assertBridgeResultCanMutateState(result, {
        requestId: 'req-1',
        command: 'opencode.launchTeam',
        runId: 'run-1',
        capabilitySnapshotId: 'new-snapshot',
      })
    ).toThrow('OpenCode bridge capability snapshot mismatch');
  });

  it('allows state mutation when caller has no capability snapshot evidence to compare', () => {
    const result = bridgeSuccess({
      runtime: { capabilitySnapshotId: 'runtime-snapshot' },
      data: { runId: 'run-1' },
    });

    expect(() =>
      assertBridgeResultCanMutateState(result, {
        requestId: 'req-1',
        command: 'opencode.launchTeam',
        runId: 'run-1',
        capabilitySnapshotId: null,
      })
    ).not.toThrow();
  });

  it('rejects state-changing bridge evidence with stale manifest or idempotency mismatch', () => {
    const result = bridgeSuccess({
      data: {
        runId: 'run-1',
        idempotencyKey: 'key-1',
        runtimeStoreManifestHighWatermark: 9,
      },
    });

    expect(() =>
      assertBridgeEvidenceCanCommitToRuntimeStores({
        result,
        requestId: 'req-1',
        command: 'opencode.launchTeam',
        runId: 'run-1',
        capabilitySnapshotId: 'cap-1',
        manifest: { highWatermark: 10 },
        idempotencyKey: 'key-1',
      })
    ).toThrow('Bridge result manifest high watermark is stale');

    expect(() =>
      assertBridgeEvidenceCanCommitToRuntimeStores({
        result: bridgeSuccess({
          data: {
            runId: 'run-1',
            idempotencyKey: 'other-key',
            runtimeStoreManifestHighWatermark: 10,
          },
        }),
        requestId: 'req-1',
        command: 'opencode.launchTeam',
        runId: 'run-1',
        capabilitySnapshotId: 'cap-1',
        manifest: { highWatermark: 10 },
        idempotencyKey: 'key-1',
      })
    ).toThrow('Bridge result idempotency key mismatch');
  });

  it('rejects handshake when server manifest high watermark is stale', () => {
    const client = peerIdentity('claude_team');
    const server = peerIdentity('agent_teams_orchestrator', {
      runtimeStoreManifestHighWatermark: 9,
    });
    const handshake = buildHandshake({ client, server });

    expect(
      validateOpenCodeBridgeHandshake({
        handshake,
        expectedClient: client,
        requiredCommand: 'opencode.launchTeam',
        expectedCapabilitySnapshotId: 'cap-1',
        expectedManifestHighWatermark: 10,
        expectedRunId: 'run-1',
      })
    ).toEqual({
      ok: false,
      reason: 'Bridge server runtime manifest high watermark is stale',
    });
  });

  it('rejects handshake when identity hash does not match peer evidence', () => {
    const client = peerIdentity('claude_team');
    const server = peerIdentity('agent_teams_orchestrator');
    const handshake: OpenCodeBridgeHandshake = {
      ...buildHandshake({ client, server }),
      identityHash: 'tampered',
    };

    expect(
      validateOpenCodeBridgeHandshake({
        handshake,
        expectedClient: client,
        requiredCommand: 'opencode.launchTeam',
        expectedCapabilitySnapshotId: 'cap-1',
        expectedManifestHighWatermark: 10,
        expectedRunId: 'run-1',
      })
    ).toEqual({
      ok: false,
      reason: 'Bridge handshake identity hash mismatch',
    });
  });

  it('creates deterministic idempotency keys for equivalent JSON bodies', () => {
    const first = createOpenCodeBridgeIdempotencyKey({
      command: 'opencode.launchTeam',
      teamName: 'Team A',
      runId: 'run-1',
      body: { a: 1, b: { c: true, d: ['x'] } },
    });
    const second = createOpenCodeBridgeIdempotencyKey({
      command: 'opencode.launchTeam',
      teamName: 'Team A',
      runId: 'run-1',
      body: { b: { d: ['x'], c: true }, a: 1 },
    });

    expect(first).toBe(second);
    expect(first).toMatch(
      /^opencode:opencode\.launchTeam:Team_A:no-lane:run-1:[a-f0-9]{32}$/
    );
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
  });
});

type BridgeSuccessOverrides = Omit<Partial<OpenCodeBridgeSuccess<unknown>>, 'runtime'> & {
  runtime?: Partial<OpenCodeBridgeRuntimeSnapshot>;
  data?: unknown;
};

function bridgeSuccess(overrides: BridgeSuccessOverrides = {}): OpenCodeBridgeSuccess<unknown> {
  const { runtime: runtimeOverrides, ...rest } = overrides;
  return {
    ok: true,
    schemaVersion: 1,
    requestId: 'req-1',
    command: 'opencode.launchTeam',
    completedAt: '2026-04-21T12:00:01.000Z',
    durationMs: 1000,
    runtime: {
      providerId: 'opencode',
      binaryPath: '/usr/local/bin/opencode',
      binaryFingerprint: 'bin-1',
      version: '1.0.0',
      capabilitySnapshotId: 'cap-1',
      ...runtimeOverrides,
    },
    diagnostics: [],
    data: {
      runId: 'run-1',
      idempotencyKey: 'key-1',
      runtimeStoreManifestHighWatermark: 10,
    },
    ...rest,
  };
}

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
    },
    runtime: {
      providerId: 'opencode',
      binaryPath: '/usr/local/bin/opencode',
      binaryFingerprint: 'bin-1',
      version: '1.0.0',
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

function buildHandshake(input: {
  client: OpenCodeBridgePeerIdentity;
  server: OpenCodeBridgePeerIdentity;
}): OpenCodeBridgeHandshake {
  const withoutHash: Omit<OpenCodeBridgeHandshake, 'identityHash'> = {
    schemaVersion: 1,
    requestId: 'handshake-1',
    client: input.client,
    server: input.server,
    agreedProtocolVersion: 1,
    acceptedCommands: ['opencode.launchTeam', 'opencode.stopTeam'],
    serverTime: '2026-04-21T12:00:00.000Z',
  };

  return {
    ...withoutHash,
    identityHash: createOpenCodeBridgeHandshakeIdentityHash(withoutHash),
  };
}
