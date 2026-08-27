import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeBridgeHandshakeIdentityHash,
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
  OPEN_CODE_FILE_PARTS_CONTRACT_VERSION,
  type OpenCodeBridgeCommandName,
  type OpenCodeBridgeHandshake,
  type OpenCodeBridgePeerIdentity,
  type OpenCodeBridgeResult,
  type OpenCodeBridgeSuccess,
  type OpenCodeLaunchTeamCommandBody,
  type RuntimeStoreManifestEvidence,
  stableHash,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
  OpenCodeBridgeCommandLeaseError,
  type OpenCodeBridgeCommandLeaseStore,
  type OpenCodeBridgeCommandLedger,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import { OpenCodeReadinessBridge } from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import {
  type OpenCodeBridgeCommandExecutor,
  type OpenCodeBridgeHandshakePort,
  OpenCodeStateChangingBridgeCommandService,
  type OpenCodeStateChangingBridgeDiagnosticsSink,
  resolveOpenCodeBridgeLeaseAcquireTimeoutMs,
  type RuntimeStoreManifestReader,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import { createOpenCodeStrictLaunchLedgerKey } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStrictLaunchLedgerIdentity';
import { REQUIRED_AGENT_TEAMS_APP_TOOL_IDS } from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import {
  type OpenCodeRuntimeAdapterLaunchPorts,
  runOpenCodeTeamRuntimeAdapterLaunch,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeAdapterLaunch';
import { RosterLaunchKnownNoStartError } from '../../../../src/main/services/team/provisioning/TeamProvisioningRosterLaunchOutcome';
import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import orchestratorVector from '../../../fixtures/team/opencode-launch-request-correlation-golden.json';

import type { OpenCodeLaunchAttemptResponse } from '../../../../src/main/services/team/opencode/bridge/OpenCodeLaunchAttemptContractV1';
import type { OpenCodeTeamLaunchReadiness } from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';
import type { TeamRuntimeLaunchInput } from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import type { PersistedOpenCodeStrictLaunchAttempt } from '../../../../src/shared/types/openCodeStrictLaunch';
import type { TeamCreateRequest } from '../../../../src/shared/types/team';

describe('OpenCodeStateChangingBridgeCommandService', () => {
  let tempDir: string;
  let now: Date;
  let nextLeaseId: number;
  let ledger: OpenCodeBridgeCommandLedger;
  let leaseStore: OpenCodeBridgeCommandLeaseStore;
  let bridge: FakeBridgeExecutor;
  let handshakePort: FakeHandshakePort;
  let manifestReader: FakeManifestReader;
  let diagnostics: FakeDiagnosticsSink;
  let clientIdentity: OpenCodeBridgePeerIdentity;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-state-bridge-'));
    now = new Date('2026-04-21T12:00:00.000Z');
    nextLeaseId = 1;
    ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });
    leaseStore = createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(tempDir, 'leases.json'),
      idFactory: () => `lease-${nextLeaseId++}`,
      clock: () => now,
    });
    clientIdentity = peerIdentity('claude_team');
    handshakePort = new FakeHandshakePort(
      buildHandshake({
        client: clientIdentity,
        server: peerIdentity('agent_teams_orchestrator'),
      })
    );
    manifestReader = new FakeManifestReader();
    bridge = new FakeBridgeExecutor();
    diagnostics = new FakeDiagnosticsSink();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects state-changing command when bridge handshake has stale manifest high watermark', async () => {
    handshakePort.nextHandshake = buildHandshake({
      client: clientIdentity,
      server: peerIdentity('agent_teams_orchestrator', {
        runtimeStoreManifestHighWatermark: 9,
      }),
    });
    const service = createService();

    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'Bridge server runtime manifest high watermark is stale'
    );

    expect(bridge.calls).toHaveLength(0);
    await expect(ledger.list()).resolves.toEqual([]);
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('forwards opaque invocation authority across deferred manifest work and fails known-no-start when invalidated', async () => {
    const manifestStarted = deferred<void>();
    const releaseManifest = deferred<RuntimeStoreManifestEvidence>();
    manifestReader.read = vi.fn(async () => {
      manifestStarted.resolve();
      return releaseManifest.promise;
    });
    let authorityCurrent = true;
    const onInvocationDispatched = vi.fn();
    const service = createService();
    const executing = service.execute({
      ...buildLaunchInput(),
      invocationAuthority: {
        invoke(invocation) {
          if (!authorityCurrent) {
            throw new RosterLaunchKnownNoStartError('launch authority invalidated');
          }
          authorityCurrent = false;
          return invocation();
        },
      },
      onInvocationDispatched,
    });
    await manifestStarted.promise;
    authorityCurrent = false;
    releaseManifest.resolve(manifestReader.manifest);

    await expect(executing).rejects.toBeInstanceOf(RosterLaunchKnownNoStartError);
    expect(bridge.calls).toHaveLength(0);
    expect(onInvocationDispatched).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: 'strict launch contract',
      configure(server: OpenCodeBridgePeerIdentity) {
        server.bridgeProtocol.openCodeLaunchAttemptContract = 0;
      },
      error: 'openCodeLaunchAttemptContract 1',
    },
    {
      kind: 'request correlation contract',
      configure(server: OpenCodeBridgePeerIdentity) {
        server.bridgeProtocol.openCodeLaunchRequestCorrelationContract = 0;
      },
      error: 'openCodeLaunchRequestCorrelationContract 1',
    },
    {
      kind: 'capability snapshot',
      configure(server: OpenCodeBridgePeerIdentity) {
        server.runtime.capabilitySnapshotId = 'cap-other';
      },
      error: 'capability snapshot mismatch',
    },
  ])(
    'does not let upstream dispatch authorization bypass the OpenCode $kind before member mutation',
    async ({ configure, error }) => {
      const server = peerIdentity('agent_teams_orchestrator');
      configure(server);
      handshakePort.nextHandshake = buildHandshake({ client: clientIdentity, server });
      const service = createService();

      await expect(service.execute(buildLaunchInput())).rejects.toThrow(error);
      expect(bridge.calls).toHaveLength(0);
      await expect(ledger.list()).resolves.toEqual([]);
      await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
    }
  );

  it('requires delivery acceptance contract only for acceptance-mode sendMessage', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    const server = peerIdentity('agent_teams_orchestrator');
    server.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    const service = createService();

    await expect(service.execute(buildSendInput('acceptance'))).rejects.toThrow(
      'OpenCode delivery acceptance mode is required'
    );
    expect(bridge.calls).toHaveLength(0);
    await expect(ledger.list()).resolves.toEqual([]);
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();

    server.bridgeProtocol.opencodeDeliveryAcceptanceContractVersion =
      OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION;
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    await expect(service.execute(buildSendInput('acceptance'))).resolves.toMatchObject({
      ok: true,
    });
    expect(bridge.calls).toHaveLength(1);
  });

  it('requires the file-parts v2 contract only when sendMessage contains video', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    const server = peerIdentity('agent_teams_orchestrator');
    server.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    const service = createService();
    const videoFileParts = [
      {
        type: 'file' as const,
        mime: 'video/mp4',
        url: 'data:video/mp4;base64,AAAA',
        filename: 'clip.mp4',
      },
    ];
    const videoInput = buildSendInput('observed', videoFileParts);
    const acceptanceVideoInput = buildSendInput('acceptance', videoFileParts);

    await expect(service.execute(videoInput)).rejects.toThrow(
      'OpenCode video file parts require orchestrator contract version'
    );
    await expect(service.execute(acceptanceVideoInput)).rejects.toThrow(
      'OpenCode video file parts require orchestrator contract version'
    );
    expect(bridge.calls).toHaveLength(0);

    server.bridgeProtocol.opencodeFilePartsContractVersion = OPEN_CODE_FILE_PARTS_CONTRACT_VERSION;
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });

    await expect(service.execute(videoInput)).resolves.toMatchObject({ ok: true });
    expect(bridge.calls).toHaveLength(1);
  });

  it('does not apply runtime-store high watermark preconditions to sendMessage delivery', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    const server = peerIdentity('agent_teams_orchestrator', {
      runtimeStoreManifestHighWatermark: 0,
    });
    server.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    server.bridgeProtocol.opencodeDeliveryAcceptanceContractVersion =
      OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION;
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 0,
        },
      });
    const service = createService();

    await expect(service.execute(buildSendInput('acceptance'))).resolves.toMatchObject({
      ok: true,
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].body.preconditions).toMatchObject({
      expectedManifestHighWatermark: null,
      idempotencyKey: expect.stringMatching(
        /^opencode:opencode\.sendMessage:team-a:secondary_opencode_bob:run-1:/
      ),
    });
    await expect(
      ledger.getByIdempotencyKey(bridge.calls[0].body.preconditions.idempotencyKey)
    ).resolves.toMatchObject({
      requestId: 'cmd-1',
      status: 'completed',
      retryable: false,
      strictLaunchResponseJson: null,
    });
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('does not let app-owned runtime manifest progress block an exact-run stop', async () => {
    handshakePort.nextHandshake = buildHandshake({
      client: clientIdentity,
      server: peerIdentity('agent_teams_orchestrator', {
        runtimeStoreManifestHighWatermark: 0,
      }),
    });
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          stopped: true,
          members: {},
          warnings: [],
          diagnostics: [],
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 0,
        },
      });
    const service = createService();

    await expect(service.execute(buildStopInput())).resolves.toMatchObject({
      ok: true,
      data: { runId: 'run-1', stopped: true },
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].body.preconditions).toMatchObject({
      laneId: 'primary',
      expectedRunId: 'run-1',
      expectedManifestHighWatermark: null,
      idempotencyKey: expect.stringMatching(/^opencode:opencode\.stopTeam:team-a:primary:run-1:/),
    });
    await expect(
      ledger.getByIdempotencyKey(bridge.calls[0].body.preconditions.idempotencyKey)
    ).resolves.toMatchObject({
      requestId: 'cmd-1',
      status: 'completed',
      retryable: false,
    });
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('still rejects a stop when the bridge reports a different active run', async () => {
    handshakePort.nextHandshake = buildHandshake({
      client: clientIdentity,
      server: peerIdentity('agent_teams_orchestrator', {
        runtimeStoreManifestHighWatermark: 0,
        activeRunId: 'run-2',
      }),
    });
    const service = createService();

    await expect(service.execute(buildStopInput())).rejects.toThrow(
      'Bridge server active run mismatch'
    );
    expect(bridge.calls).toHaveLength(0);
    await expect(ledger.list()).resolves.toEqual([]);
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('accepts opaque realpath/plan server digests when the request echo matches', async () => {
    bridge.resultFactory = ({ body, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          members: {},
          launchAttempt: strictLaunchResponse(body as unknown as OpenCodeLaunchTeamCommandBody),
        },
      });
    const service = createService();

    const result = await service.execute(buildLaunchInput());

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      data: {
        launchAttempt: {
          launchAttempt: {
            inputDigest: orchestratorVector.wire.response.launchAttempt.inputDigest,
            immutableDigest: orchestratorVector.wire.response.launchAttempt.immutableDigest,
          },
        },
      },
    });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].options).toMatchObject({ requestId: 'cmd-1' });
    expect(bridge.calls[0].body).toMatchObject({
      prompt: 'launch',
      preconditions: {
        handshakeIdentityHash: handshakePort.nextHandshake.identityHash,
        expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: 'cap-1',
        expectedBehaviorFingerprint: 'behavior-1',
        expectedManifestHighWatermark: 10,
        commandLeaseId: 'lease-1',
        idempotencyKey: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
      },
    });
    await expect(
      ledger.getByIdempotencyKey(bridge.calls[0].body.preconditions.idempotencyKey)
    ).resolves.toMatchObject({
      requestId: 'cmd-1',
      status: 'completed',
      retryable: false,
      completedAt: '2026-04-21T12:00:00.000Z',
    });
    expect(bridge.calls[0].body).toMatchObject({
      launchAttempt: {
        requestCorrelationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it.each(['before', 'after'] as const)(
    'replays the exact strict response after an app restart crash %s completion persistence',
    async (failurePoint) => {
      bridge.resultFactory = ({ body, options }) => {
        const launchBody = body as unknown as OpenCodeLaunchTeamCommandBody;
        const launchAttempt = strictLaunchResponse(launchBody);
        launchAttempt.launchAttempt.outcome = 'partial';
        launchAttempt.launchAttempt.phase = 'cleanup';
        launchAttempt.members.committed = launchAttempt.members.committed.slice(0, 1);
        launchAttempt.members.failed = [
          {
            memberIdentity: launchBody.members[1]!.memberIdentity,
            failure: {
              code: 'rate_limited',
              origin: 'provider',
              retryDisposition: 'backoff',
              retryable: true,
              phase: 'member_materialize',
              sideEffectsStarted: false,
            },
          },
        ];
        launchAttempt.members.continuationToken = 'opaque-continuation-token';
        launchAttempt.failure = {
          code: 'deadline_after_partial',
          origin: 'deadline',
          retryDisposition: 'continuation',
          retryable: true,
          phase: 'member_materialize',
          sideEffectsStarted: true,
        };
        return bridgeSuccess({
          requestId: options.requestId,
          data: {
            runId: 'run-1',
            idempotencyKey: body.preconditions.idempotencyKey,
            runtimeStoreManifestHighWatermark: 10,
            members: strictLaunchMembers(launchBody),
            launchAttempt,
          },
        });
      };
      const crash = new Error(`crash-${failurePoint}-completion-persistence`);
      const firstService = createService({
        failpoints: {
          ...(failurePoint === 'before'
            ? { beforeStrictLaunchCompletionPersistence: () => Promise.reject(crash) }
            : { afterStrictLaunchCompletionPersistence: () => Promise.reject(crash) }),
        },
      });

      await expect(firstService.execute(buildLaunchInput())).rejects.toThrow(crash.message);
      expect(bridge.calls).toHaveLength(1);

      const restartedService = createService();
      const onInvocationDisposition = vi.fn();
      const onInvocationDispatched = vi.fn();
      const replay = await restartedService.execute({
        ...buildLaunchInput(),
        onInvocationDisposition,
        onInvocationDispatched,
      });

      expect(bridge.calls).toHaveLength(1);
      expect(onInvocationDisposition).toHaveBeenCalledOnce();
      expect(onInvocationDisposition).toHaveBeenCalledWith('previous_side_effects_recovered');
      expect(onInvocationDispatched).not.toHaveBeenCalled();
      expect(replay).toMatchObject({
        ok: true,
        data: {
          members: {
            alice: {
              sessionId: 'session-0',
              launchState: 'confirmed_alive',
            },
          },
          launchAttempt: {
            launchAttempt: { outcome: 'partial' },
            members: { continuationToken: 'opaque-continuation-token' },
          },
        },
      });
      const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
      await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
        status: 'completed',
        responseHash: stableHash(
          (replay as OpenCodeBridgeSuccess<{ launchAttempt: unknown }>).data.launchAttempt
        ),
        strictLaunchResponseJson: expect.stringContaining('opaque-continuation-token'),
        strictLaunchMemberLinkageJson: expect.stringContaining('session-0'),
      });
    }
  );

  it('publishes previous side effects before a restarted partial replay completion is released', async () => {
    bridge.resultFactory = strictLaunchBridgeResult(({ response, body }) => {
      makeStrictLaunchPartial(response, body);
    });
    const crash = new Error('crash-before-replay-completion');
    await expect(
      createService({
        failpoints: {
          beforeStrictLaunchCompletionPersistence: () => Promise.reject(crash),
        },
      }).execute(buildLaunchInput())
    ).rejects.toThrow(crash.message);

    const replayPaused = deferred<void>();
    const releaseReplay = deferred<void>();
    const onInvocationDisposition = vi.fn();
    const onInvocationDispatched = vi.fn();
    const replay = createService({
      failpoints: {
        beforeStrictLaunchCompletionPersistence: () => {
          replayPaused.resolve(undefined);
          return releaseReplay.promise;
        },
      },
    }).execute({
      ...buildLaunchInput(),
      onInvocationDisposition,
      onInvocationDispatched,
    });

    await replayPaused.promise;
    expect(onInvocationDisposition).toHaveBeenCalledWith('previous_side_effects_recovered');
    expect(onInvocationDispatched).not.toHaveBeenCalled();
    expect(bridge.calls).toHaveLength(1);

    releaseReplay.resolve(undefined);
    await expect(replay).resolves.toMatchObject({
      ok: true,
      data: { launchAttempt: { launchAttempt: { outcome: 'partial' } } },
    });
  });

  it('replays a completed restart launch before manifest, handshake, or crash-owned lease access', async () => {
    bridge.resultFactory = ({ body, options }) => {
      const launchBody = body as unknown as OpenCodeLaunchTeamCommandBody;
      return bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          members: strictLaunchMembers(launchBody),
          launchAttempt: strictLaunchResponse(launchBody),
        },
      });
    };
    await createService().execute(buildLaunchInput());
    const crashOwnedLease = await leaseStore.acquire({
      teamName: 'team-a',
      laneId: null,
      runId: 'run-1',
      command: 'opencode.launchTeam',
      ttlMs: 60_000,
    });
    const manifestRead = vi
      .spyOn(manifestReader, 'read')
      .mockRejectedValue(new Error('manifest unavailable after restart'));
    const handshake = vi
      .spyOn(handshakePort, 'handshake')
      .mockRejectedValue(new Error('bridge unavailable after restart'));

    await expect(createService().execute(buildLaunchInput())).resolves.toMatchObject({
      ok: true,
      data: {
        members: {
          alice: { sessionId: 'session-0' },
          bob: { sessionId: 'session-1' },
        },
        launchAttempt: { launchAttempt: { outcome: 'succeeded' } },
      },
    });

    expect(manifestRead).not.toHaveBeenCalled();
    expect(handshake).not.toHaveBeenCalled();
    expect(bridge.calls).toHaveLength(1);
    await expect(leaseStore.getActive('team-a')).resolves.toMatchObject({
      leaseId: crashOwnedLease.leaseId,
      state: 'active',
    });
  });

  it.each(['legacy', 'tampered'] as const)(
    'replays a %s strict success as reconciliation-required without redispatch',
    async (recordKind) => {
      bridge.resultFactory = ({ body, options }) => {
        const launchBody = body as unknown as OpenCodeLaunchTeamCommandBody;
        return bridgeSuccess({
          requestId: options.requestId,
          data: {
            runId: 'run-1',
            idempotencyKey: body.preconditions.idempotencyKey,
            runtimeStoreManifestHighWatermark: 10,
            members: strictLaunchMembers(launchBody),
            launchAttempt: strictLaunchResponse(launchBody),
          },
        });
      };
      await createService().execute(buildLaunchInput());
      const ledgerPath = path.join(tempDir, 'ledger.json');
      const envelope = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as {
        data: Array<{
          strictLaunchMemberLinkageJson?: string;
          strictLaunchMemberLinkageHash?: string;
        }>;
      };
      if (recordKind === 'legacy') {
        delete envelope.data[0]!.strictLaunchMemberLinkageJson;
        delete envelope.data[0]!.strictLaunchMemberLinkageHash;
      } else {
        envelope.data[0]!.strictLaunchMemberLinkageJson = JSON.stringify({
          schemaVersion: 1,
          members: { alice: { sessionId: 'attacker-session' } },
        });
      }
      await fs.writeFile(ledgerPath, `${JSON.stringify(envelope)}\n`, 'utf8');

      const replay = await createService().execute(buildLaunchInput());

      expect(bridge.calls).toHaveLength(1);
      expect(replay).toMatchObject({
        ok: true,
        data: {
          members: {},
          launchAttempt: { launchAttempt: { outcome: 'reconciliation_required' } },
          diagnostics: [
            {
              code: 'opencode_strict_launch_replay_reconciliation_required',
            },
          ],
        },
      });
    }
  );

  it('fails a restart replay request-hash mismatch before external recovery work', async () => {
    bridge.resultFactory = ({ body, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          members: {},
          launchAttempt: strictLaunchResponse(body as unknown as OpenCodeLaunchTeamCommandBody),
        },
      });
    await createService().execute(buildLaunchInput());
    const ledgerPath = path.join(tempDir, 'ledger.json');
    const envelope = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as {
      data: Array<{ requestHash: string }>;
    };
    envelope.data[0]!.requestHash = stableHash('wrong-request');
    await fs.writeFile(ledgerPath, `${JSON.stringify(envelope)}\n`, 'utf8');
    const manifestRead = vi.spyOn(manifestReader, 'read');
    const handshake = vi.spyOn(handshakePort, 'handshake');

    await expect(createService().execute(buildLaunchInput())).rejects.toThrow(
      'OpenCode bridge idempotency key reused with different payload'
    );
    expect(manifestRead).not.toHaveBeenCalled();
    expect(handshake).not.toHaveBeenCalled();
    expect(bridge.calls).toHaveLength(1);
  });

  it.each(['hash', 'correlation'] as const)(
    'fails closed on durable strict response %s corruption without bridge redispatch',
    async (corruption) => {
      bridge.resultFactory = ({ body, options }) =>
        bridgeSuccess({
          requestId: options.requestId,
          data: {
            runId: 'run-1',
            idempotencyKey: body.preconditions.idempotencyKey,
            runtimeStoreManifestHighWatermark: 10,
            members: {},
            launchAttempt: strictLaunchResponse(body as unknown as OpenCodeLaunchTeamCommandBody),
          },
        });
      await createService().execute(buildLaunchInput());
      const ledgerPath = path.join(tempDir, 'ledger.json');
      const envelope = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as {
        data: Array<{
          responseHash: string;
          strictLaunchResponseJson: string;
        }>;
      };
      const entry = envelope.data[0]!;
      if (corruption === 'hash') {
        entry.responseHash = stableHash('wrong-response');
      } else {
        const stored = JSON.parse(entry.strictLaunchResponseJson) as {
          launchAttempt: { attemptId: string };
        };
        stored.launchAttempt.attemptId = '018f47a2-4a13-7c2f-8d44-deadbeef0000';
        entry.strictLaunchResponseJson = JSON.stringify(stored);
        entry.responseHash = stableHash(stored);
      }
      await fs.writeFile(ledgerPath, `${JSON.stringify(envelope)}\n`, 'utf8');

      const onInvocationDisposition = vi.fn();
      const onInvocationDispatched = vi.fn();
      await expect(
        createService().execute({
          ...buildLaunchInput(),
          onInvocationDisposition,
          onInvocationDispatched,
        })
      ).rejects.toThrow(
        corruption === 'hash'
          ? 'Durable OpenCode strict launch response hash mismatch'
          : 'Durable OpenCode strict launch response does not match its request'
      );
      expect(bridge.calls).toHaveLength(1);
      expect(onInvocationDisposition).toHaveBeenCalledWith('previous_side_effects_recovered');
      expect(onInvocationDispatched).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'wrong'] as const)(
    'requires %s durable request-correlation evidence for pre-handshake replay',
    async (corruption) => {
      bridge.resultFactory = ({ body, options }) =>
        bridgeSuccess({
          requestId: options.requestId,
          data: {
            runId: 'run-1',
            idempotencyKey: body.preconditions.idempotencyKey,
            runtimeStoreManifestHighWatermark: 10,
            members: {},
            launchAttempt: strictLaunchResponse(body as unknown as OpenCodeLaunchTeamCommandBody),
          },
        });
      await createService().execute(buildLaunchInput());
      const ledgerPath = path.join(tempDir, 'ledger.json');
      const envelope = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as {
        data: Array<{ requestCorrelationDigest?: string }>;
      };
      if (corruption === 'missing') {
        delete envelope.data[0]!.requestCorrelationDigest;
      } else {
        envelope.data[0]!.requestCorrelationDigest = '0'.repeat(64);
      }
      await fs.writeFile(ledgerPath, `${JSON.stringify(envelope)}\n`, 'utf8');
      const manifestRead = vi.spyOn(manifestReader, 'read');
      const handshake = vi.spyOn(handshakePort, 'handshake');

      const onInvocationDisposition = vi.fn();
      await expect(
        createService().execute({ ...buildLaunchInput(), onInvocationDisposition })
      ).rejects.toThrow('outcome must be reconciled');
      expect(manifestRead).not.toHaveBeenCalled();
      expect(handshake).not.toHaveBeenCalled();
      expect(bridge.calls).toHaveLength(1);
      expect(onInvocationDisposition).toHaveBeenCalledWith('previous_side_effects_recovered');
    }
  );

  it('publishes previous side effects before corrupt duplicate-begin replay reconstruction', async () => {
    bridge.resultFactory = strictLaunchBridgeResult();
    await createService().execute(buildLaunchInput());
    const ledgerPath = path.join(tempDir, 'ledger.json');
    const envelope = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as {
      data: Array<{ responseHash: string }>;
    };
    envelope.data[0]!.responseHash = stableHash('wrong-response');
    await fs.writeFile(ledgerPath, `${JSON.stringify(envelope)}\n`, 'utf8');
    vi.spyOn(ledger, 'list').mockResolvedValueOnce([]);
    const onInvocationDisposition = vi.fn();
    const onInvocationDispatched = vi.fn();

    await expect(
      createService().execute({
        ...buildLaunchInput(),
        onInvocationDisposition,
        onInvocationDispatched,
      })
    ).rejects.toThrow('Durable OpenCode strict launch response hash mismatch');

    expect(onInvocationDisposition).toHaveBeenCalledWith('previous_side_effects_recovered');
    expect(onInvocationDispatched).not.toHaveBeenCalled();
    expect(bridge.calls).toHaveLength(1);
  });

  it.each(['hash', 'correlation'] as const)(
    'retains exact production-adapter ownership when generation-two cancellation interrupts corrupt predecessor %s replay',
    async (corruption) => {
      bridge.resultFactory = ({ command, body, options }) => {
        if (command === 'opencode.readiness') {
          return bridgeSuccess({
            requestId: options.requestId,
            command,
            data: readyOpenCodeLaunchReadiness(),
          });
        }
        if (command === 'opencode.stopTeam') {
          return bridgeSuccess({
            requestId: options.requestId,
            command,
            data: {
              runId: 'run-1',
              stopped: false,
              members: {},
              warnings: [],
              diagnostics: [
                {
                  code: 'stop_confirmation_unavailable',
                  severity: 'warning',
                  message: 'Deterministic fake retained exact runtime ownership.',
                },
              ],
            },
          });
        }
        const launchBody = body as unknown as OpenCodeLaunchTeamCommandBody;
        const response = strictLaunchResponse(launchBody);
        if (launchBody.launchAttempt.generation === 1) {
          makeStrictLaunchPartial(response, launchBody);
        }
        return bridgeSuccess({
          requestId: options.requestId,
          command,
          data: {
            runId: launchBody.runId,
            idempotencyKey: body.preconditions.idempotencyKey,
            runtimeStoreManifestHighWatermark: 10,
            members: strictLaunchMembers(launchBody),
            launchAttempt: response,
          },
        });
      };
      const seedAdapter = createProductionAdapter(createService(), bridge);
      const generationOne = await seedAdapter.launch(buildAdapterLaunchInput());
      expect(generationOne).toMatchObject({
        teamLaunchState: 'partial_pending',
        members: { alice: { launchState: 'confirmed_alive' } },
      });
      const partialSnapshot = buildPartialLaunchSnapshot(
        generationOne.openCodeStrictLaunchAttempt!
      );

      const ledgerPath = path.join(tempDir, 'ledger.json');
      const envelope = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as {
        data: Array<{ responseHash: string; requestCorrelationDigest?: string }>;
      };
      const entry = envelope.data[0]!;
      if (corruption === 'hash') {
        entry.responseHash = stableHash('wrong-response');
      } else {
        entry.requestCorrelationDigest = '0'.repeat(64);
      }
      await fs.writeFile(ledgerPath, `${JSON.stringify(envelope)}\n`, 'utf8');

      ledger = createOpenCodeBridgeCommandLedgerStore({ filePath: ledgerPath, clock: () => now });
      leaseStore = createOpenCodeBridgeCommandLeaseStore({
        filePath: path.join(tempDir, 'leases.json'),
        idFactory: () => `lease-${nextLeaseId++}`,
        clock: () => now,
      });
      const replayDispositionPublished = deferred<void>();
      const releaseReplay = deferred<void>();
      const restartedAdapter = createProductionAdapter(
        createService({
          failpoints: {
            afterStrictLaunchReplayDisposition: () => {
              replayDispositionPublished.resolve(undefined);
              return releaseReplay.promise;
            },
          },
        }),
        bridge
      );
      const replayHarness = createProvisioningLaunchHarness(restartedAdapter, partialSnapshot);
      const replay = runOpenCodeTeamRuntimeAdapterLaunch(replayHarness.input, replayHarness.ports);

      await replayDispositionPublished.promise;
      expect(replayHarness.runtimeOwner()).toMatchObject({
        runId: 'run-1',
        providerId: 'opencode',
        cwd: '/tmp/project',
      });
      replayHarness.cancel();
      releaseReplay.resolve(undefined);

      await expect(replay).resolves.toEqual({ runId: 'run-1' });
      expect(bridge.calls.filter((call) => call.command === 'opencode.launchTeam')).toHaveLength(1);
      expect(bridge.calls.filter((call) => call.command === 'opencode.stopTeam')).toHaveLength(1);
      expect(replayHarness.clearPrimaryLane).not.toHaveBeenCalled();
      expect(replayHarness.runtimeOwner()).toMatchObject({
        runId: 'run-1',
        providerId: 'opencode',
        cwd: '/tmp/project',
      });
    }
  );

  it('composes the runtime adapter through the durable bridge for partial continuation and replay', async () => {
    bridge.resultFactory = ({ command, body, options }) => {
      if (command === 'opencode.readiness') {
        return bridgeSuccess({
          requestId: options.requestId,
          command,
          data: readyOpenCodeLaunchReadiness(),
        });
      }
      const launchBody = body as unknown as OpenCodeLaunchTeamCommandBody;
      const response = strictLaunchResponse(launchBody);
      if (launchBody.launchAttempt.generation === 1) {
        makeStrictLaunchPartial(response, launchBody);
      }
      return bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: launchBody.runId,
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          members: strictLaunchMembers(launchBody),
          launchAttempt: response,
        },
      });
    };
    const adapterInput = buildAdapterLaunchInput();
    const firstAdapter = createProductionAdapter(createService(), bridge);
    const first = await firstAdapter.launch(adapterInput);
    const partialSnapshot = buildPartialLaunchSnapshot(first.openCodeStrictLaunchAttempt!);

    // Recreate every durable component over the same files to prove restart
    // behavior, then replay generation two from the exact persisted cursor.
    ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });
    leaseStore = createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(tempDir, 'leases.json'),
      idFactory: () => `lease-${nextLeaseId++}`,
      clock: () => now,
    });
    const restartedAdapter = createProductionAdapter(createService(), bridge);
    const continuationInput = { ...adapterInput, previousLaunchState: partialSnapshot };
    const second = await restartedAdapter.launch(continuationInput);
    const onInvocationDisposition = vi.fn();
    const onInvocationDispatched = vi.fn();
    const replay = await restartedAdapter.launch({
      ...continuationInput,
      onInvocationDisposition,
      onInvocationDispatched,
    });

    const dispatches = bridge.calls.filter((call) => call.command === 'opencode.launchTeam');
    expect(dispatches).toHaveLength(2);
    const firstAttempt = (dispatches[0]!.body as unknown as OpenCodeLaunchTeamCommandBody)
      .launchAttempt;
    const secondAttempt = (dispatches[1]!.body as unknown as OpenCodeLaunchTeamCommandBody)
      .launchAttempt;
    expect(secondAttempt).toMatchObject({
      attemptId: firstAttempt.attemptId,
      payloadHash: firstAttempt.payloadHash,
      generation: 2,
      continuationToken: 'opaque-continuation-token',
    });
    expect(dispatches[1]!.body.preconditions.idempotencyKey).toBe(firstAttempt.attemptId);
    expect(second.teamLaunchState).toBe('clean_success');
    expect(onInvocationDisposition).toHaveBeenCalledWith('previous_side_effects_recovered');
    expect(onInvocationDispatched).not.toHaveBeenCalled();
    expect(replay).toMatchObject({
      teamLaunchState: second.teamLaunchState,
      launchPhase: second.launchPhase,
      members: {
        alice: { launchState: 'confirmed_alive', sessionId: second.members.alice!.sessionId },
        bob: { launchState: 'confirmed_alive', sessionId: second.members.bob!.sessionId },
      },
    });
    await expect(ledger.list()).resolves.toHaveLength(2);
    await expect(
      ledger.getByIdempotencyKey(createOpenCodeStrictLaunchLedgerKey(firstAttempt.attemptId, 2))
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('rejects skipped, stale, forked, and mismatched continuation generations', async () => {
    bridge.resultFactory = strictLaunchBridgeResult(({ response, body }) => {
      makeStrictLaunchPartial(response, body);
    });
    await createService().execute(buildLaunchInput());
    const generation2 = buildContinuationInput(buildLaunchInput(), 2);

    const skipped = buildContinuationInput(buildLaunchInput(), 3);
    await expect(createService().execute(skipped)).rejects.toThrow('cannot skip or fork');
    const wrongToken = buildContinuationInput(buildLaunchInput(), 2, 'wrong-token');
    await expect(createService().execute(wrongToken)).rejects.toThrow(
      'continuation evidence does not match'
    );

    bridge.resultFactory = strictLaunchBridgeResult();
    await expect(createService().execute(generation2)).resolves.toMatchObject({ ok: true });
    const forked = structuredClone(generation2);
    (forked.body as OpenCodeLaunchTeamCommandBody).leadPrompt = 'forked payload';
    await expect(createService().execute(forked)).rejects.toThrow(
      'idempotency key reused with different payload'
    );
    await expect(createService().execute(skipped)).rejects.toThrow(
      'continuation evidence does not match'
    );
    expect(bridge.calls).toHaveLength(2);
  });

  it('does not retry or continue an uncertain strict launch generation', async () => {
    bridge.resultFactory = ({ command, options }) => ({
      ok: false,
      schemaVersion: 1,
      requestId: options.requestId ?? 'cmd-1',
      command,
      completedAt: now.toISOString(),
      durationMs: 10_000,
      diagnostics: [],
      error: {
        kind: 'timeout',
        message: 'transport outcome unknown',
        retryable: false,
      },
    });
    const generation1 = buildLaunchInput();
    await expect(createService().execute(generation1)).resolves.toMatchObject({ ok: false });
    await expect(createService().execute(generation1)).rejects.toThrow(
      'outcome must be reconciled before retry'
    );
    await expect(createService().execute(buildContinuationInput(generation1, 2))).rejects.toThrow(
      'predecessor must be durably completed'
    );
    expect(bridge.calls).toHaveLength(1);
  });

  it.each(['missing', 'wrong'] as const)(
    'rejects a strict success whose request-correlation echo is %s',
    async (corruption) => {
      bridge.resultFactory = ({ body, options }) => {
        const launchAttempt = strictLaunchResponse(
          body as unknown as OpenCodeLaunchTeamCommandBody
        );
        if (corruption === 'missing') {
          delete launchAttempt.launchAttempt.requestCorrelationDigest;
        } else {
          launchAttempt.launchAttempt.requestCorrelationDigest = '0'.repeat(64);
        }
        return bridgeSuccess({
          requestId: options.requestId,
          data: {
            runId: 'run-1',
            idempotencyKey: body.preconditions.idempotencyKey,
            runtimeStoreManifestHighWatermark: 10,
            members: {},
            launchAttempt,
          },
        });
      };

      await expect(createService().execute(buildLaunchInput())).rejects.toThrow(
        'launchAttempt.requestCorrelationDigest'
      );
      expect(bridge.calls).toHaveLength(1);
      const launchBody = buildLaunchInput().body as OpenCodeLaunchTeamCommandBody;
      await expect(
        ledger.getByIdempotencyKey(launchBody.launchAttempt.attemptId)
      ).resolves.toMatchObject({
        status: 'unknown_after_timeout',
        strictLaunchResponseJson: null,
        requestCorrelationDigest: null,
        lastError: expect.stringContaining('outcome must be reconciled'),
      });
    }
  );

  it('waits briefly for an active lane lease instead of failing near-concurrent sends', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    const server = peerIdentity('agent_teams_orchestrator');
    server.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    server.bridgeProtocol.opencodeDeliveryAcceptanceContractVersion =
      OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION;
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    const service = createService({
      leaseAcquireTimeoutMs: 200,
      leaseAcquireRetryDelayMs: 5,
    });
    const activeLease = await leaseStore.acquire({
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      runId: 'run-1',
      command: 'opencode.sendMessage',
      ttlMs: 10_000,
    });

    const resultPromise = service.execute(buildSendInput('acceptance'));
    await sleep(20);
    expect(bridge.calls).toHaveLength(0);

    await leaseStore.release(activeLease.leaseId);

    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].body.preconditions.commandLeaseId).toBe('lease-2');
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('tries acquiring the lease once more after the wait deadline elapses', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    const server = peerIdentity('agent_teams_orchestrator');
    server.bridgeProtocol.supportedCommands.push('opencode.sendMessage');
    server.bridgeProtocol.opencodeDeliveryAcceptanceContractVersion =
      OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION;
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.launchTeam', 'opencode.stopTeam', 'opencode.sendMessage']
    );
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    let acquireAttempts = 0;
    const fakeLeaseStore = {
      acquire: vi.fn(
        async (input: {
          teamName: string;
          laneId?: string | null;
          runId: string | null;
          command: OpenCodeBridgeCommandName;
          ttlMs: number;
        }) => {
          acquireAttempts += 1;
          if (acquireAttempts === 1) {
            throw new OpenCodeBridgeCommandLeaseError(
              'OpenCode bridge command lease already active: lease-1'
            );
          }
          return {
            leaseId: 'lease-2',
            teamName: input.teamName,
            laneId: input.laneId ?? null,
            runId: input.runId,
            command: input.command,
            holderPeer: 'claude_team' as const,
            acquiredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
            state: 'active' as const,
          };
        }
      ),
      release: vi.fn(async () => {}),
      getActive: vi.fn(async () => null),
    } as unknown as OpenCodeBridgeCommandLeaseStore;
    const service = new OpenCodeStateChangingBridgeCommandService({
      expectedClientIdentity: clientIdentity,
      handshakePort,
      leaseStore: fakeLeaseStore,
      ledger,
      bridge,
      manifestReader,
      diagnostics,
      requestIdFactory: () => 'cmd-1',
      diagnosticIdFactory: () => 'diag-1',
      clock: () => now,
      leaseAcquireTimeoutMs: 50,
      leaseAcquireRetryDelayMs: 60,
    });

    await expect(service.execute(buildSendInput('acceptance'))).resolves.toMatchObject({
      ok: true,
    });
    expect(fakeLeaseStore.acquire).toHaveBeenCalledTimes(2);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].body.preconditions.commandLeaseId).toBe('lease-2');
  });

  it('uses the command lease ttl as the default lease acquisition wait', () => {
    expect(
      resolveOpenCodeBridgeLeaseAcquireTimeoutMs({
        leaseTtlMs: 50_000,
      })
    ).toBe(50_000);
    expect(
      resolveOpenCodeBridgeLeaseAcquireTimeoutMs({
        leaseTtlMs: 1_000,
      })
    ).toBe(10_000);
    expect(
      resolveOpenCodeBridgeLeaseAcquireTimeoutMs({
        configuredTimeoutMs: 200,
        leaseTtlMs: 50_000,
      })
    ).toBe(200);
  });

  it.each(['timeout', 'transport_watchdog_timeout'] as const)(
    'records unknown outcome after %s and blocks retry before a duplicate bridge call',
    async (failureKind) => {
      bridge.resultFactory = ({ body, command, options }) =>
        ({
          ok: false,
          schemaVersion: 1,
          requestId: options.requestId,
          command,
          completedAt: '2026-04-21T12:00:10.000Z',
          durationMs: 10_000,
          error: {
            kind: failureKind,
            message: failureKind,
            retryable: true,
          },
          diagnostics: [],
          data: body,
        }) as OpenCodeBridgeResult<unknown>;
      const service = createService();

      const first = await service.execute(buildLaunchInput());

      expect(first).toMatchObject({
        ok: false,
        error: { kind: failureKind },
      });
      const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
      await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
        status: 'unknown_after_timeout',
        retryable: false,
        lastError: failureKind,
      });
      expect(diagnostics.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'opencode_bridge_unknown_outcome',
          data: expect.objectContaining({
            idempotencyKey,
            leaseId: 'lease-1',
          }),
        })
      );

      await expect(service.execute(buildLaunchInput())).rejects.toThrow(
        'OpenCode bridge command outcome must be reconciled before retry'
      );
      expect(bridge.calls).toHaveLength(1);
      await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
    }
  );

  it('records empty bridge output as unknown outcome and blocks duplicate retry', async () => {
    bridge.resultFactory = ({ body, command, options }) =>
      ({
        ok: false,
        schemaVersion: 1,
        requestId: options.requestId,
        command,
        completedAt: '2026-04-21T12:00:10.000Z',
        durationMs: 100,
        error: {
          kind: 'contract_violation',
          message: 'Bridge stdout was empty',
          retryable: false,
        },
        diagnostics: [],
        data: body,
      }) as OpenCodeBridgeResult<unknown>;
    const service = createService();

    const first = await service.execute(buildLaunchInput());

    expect(first).toMatchObject({
      ok: false,
      error: { kind: 'contract_violation' },
    });
    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'unknown_after_timeout',
      retryable: false,
      lastError: 'Bridge stdout was empty',
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_bridge_unknown_outcome',
        message:
          'OpenCode bridge command exited without output; outcome must be reconciled before retry',
      })
    );

    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'OpenCode bridge command outcome must be reconciled before retry'
    );
    expect(bridge.calls).toHaveLength(1);
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('marks result precondition mismatch as failed and does not leave active lease', async () => {
    bridge.resultFactory = ({ body, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 9,
        },
      });
    const service = createService();

    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'Bridge result manifest high watermark is stale'
    );

    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'failed',
      retryable: false,
      lastError: 'Bridge result manifest high watermark is stale',
    });
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('treats capability recovery attempt id as a fresh state-changing command body', async () => {
    bridge.resultFactory = ({ body, command, options }) =>
      ({
        ok: false,
        schemaVersion: 1,
        requestId: options.requestId,
        command,
        completedAt: '2026-04-21T12:00:10.000Z',
        durationMs: 10_000,
        error: {
          kind: 'provider_error',
          message: 'OpenCode bridge capability snapshot precondition mismatch',
          retryable: true,
        },
        diagnostics: [],
        data: body,
      }) as OpenCodeBridgeResult<unknown>;
    const service = createService();

    const first = await service.execute(buildLaunchInput());
    expect(first).toMatchObject({
      ok: false,
      error: { message: 'OpenCode bridge capability snapshot precondition mismatch' },
    });
    const firstIdempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(firstIdempotencyKey)).resolves.toMatchObject({
      status: 'failed',
      retryable: true,
    });

    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'OpenCode bridge command cannot be retried from status failed'
    );
    expect(bridge.calls).toHaveLength(1);

    const recovery = await service.execute({
      ...buildLaunchInput(),
      body: {
        ...(buildLaunchInput().body as OpenCodeLaunchTeamCommandBody),
        capabilitySnapshotRecoveryAttemptId: 'opencode-capability-recovery-test',
        launchAttempt: {
          ...(buildLaunchInput().body as OpenCodeLaunchTeamCommandBody).launchAttempt,
          attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee654321',
        },
      },
    });
    expect(recovery).toMatchObject({
      ok: false,
      error: { message: 'OpenCode bridge capability snapshot precondition mismatch' },
    });
    expect(bridge.calls).toHaveLength(2);
    const recoveryIdempotencyKey = bridge.calls[1].body.preconditions.idempotencyKey;
    expect(recoveryIdempotencyKey).not.toBe(firstIdempotencyKey);
    await expect(ledger.getByIdempotencyKey(recoveryIdempotencyKey)).resolves.toMatchObject({
      status: 'failed',
      retryable: true,
    });
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

  it('commits a launch result when recovery accepted a newer capability snapshot', async () => {
    bridge.resultFactory = ({ body, command, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command,
        runtime: {
          providerId: 'opencode',
          binaryPath: '/usr/local/bin/opencode',
          binaryFingerprint: 'bin-1',
          version: '1.0.0',
          capabilitySnapshotId: 'cap-2',
        },
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          diagnostics: [
            {
              code: 'opencode_capability_snapshot_recovery',
              severity: 'warning',
              message: 'Accepted fresh OpenCode capability snapshot after app recovery attempt.',
            },
          ],
          members: {},
          launchAttempt: strictLaunchResponse(body as unknown as OpenCodeLaunchTeamCommandBody),
        },
      });
    const service = createService();

    const result = await service.execute({
      ...buildLaunchInput(),
      body: {
        ...(buildLaunchInput().body as OpenCodeLaunchTeamCommandBody),
        capabilitySnapshotRecoveryAttemptId: 'opencode-capability-recovery-test',
      },
    });

    expect(result.ok).toBe(true);
    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('threads adapter invocation authority to the final bridge dispatch without firing early', async () => {
    const events: string[] = [];
    bridge.resultFactory = ({ command, body, options }) => {
      if (command === 'opencode.readiness') {
        return bridgeSuccess({
          requestId: options.requestId,
          command,
          data: readyOpenCodeLaunchReadiness(),
        });
      }
      events.push('runner');
      const launchBody = body as unknown as OpenCodeLaunchTeamCommandBody;
      return bridgeSuccess({
        requestId: options.requestId,
        command,
        data: {
          runId: launchBody.runId,
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          members: strictLaunchMembers(launchBody),
          launchAttempt: strictLaunchResponse(launchBody),
        },
      });
    };
    const input: TeamRuntimeLaunchInput = {
      ...buildAdapterLaunchInput(),
      onInvocationBoundary: async () => {
        events.push('boundary');
        return {
          invoke(invocation) {
            events.push('authority');
            return invocation();
          },
        };
      },
      onInvocationDispatched: () => events.push('dispatched'),
    };

    await expect(
      createProductionAdapter(createService(), bridge).launch(input)
    ).resolves.toMatchObject({ teamLaunchState: 'clean_success' });
    expect(events).toEqual(['boundary', 'authority', 'runner', 'dispatched']);
  });

  function createService(
    overrides: {
      leaseAcquireTimeoutMs?: number;
      leaseAcquireRetryDelayMs?: number;
      failpoints?: NonNullable<
        ConstructorParameters<typeof OpenCodeStateChangingBridgeCommandService>[0]['failpoints']
      >;
    } = {}
  ): OpenCodeStateChangingBridgeCommandService {
    return new OpenCodeStateChangingBridgeCommandService({
      expectedClientIdentity: clientIdentity,
      handshakePort,
      leaseStore,
      ledger,
      bridge,
      manifestReader,
      diagnostics,
      requestIdFactory: () => 'cmd-1',
      diagnosticIdFactory: () => 'diag-1',
      clock: () => now,
      ...overrides,
    });
  }
});

function buildLaunchInput(): Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0] {
  const payloadHash = stableHash('launch-payload');
  const opaque = (value: string) => `sha256:${stableHash(value)}` as const;
  return {
    command: 'opencode.launchTeam',
    teamName: 'team-a',
    runId: 'run-1',
    capabilitySnapshotId: 'cap-1',
    behaviorFingerprint: 'behavior-1',
    body: {
      prompt: 'launch',
      runId: 'run-1',
      laneId: 'primary',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/tmp/project',
      selectedModel: 'openai/gpt-5.4-mini',
      members: [
        {
          name: 'alice',
          role: 'teammate',
          prompt: 'launch alice',
          memberIdentity: opaque('alice'),
        },
        {
          name: 'bob',
          role: 'teammate',
          prompt: 'launch bob',
          memberIdentity: opaque('bob'),
        },
      ],
      leadPrompt: '',
      expectedCapabilitySnapshotId: null,
      manifestHighWatermark: null,
      launchContractVersion: 1,
      launchAttempt: {
        attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
        payloadHash,
        generation: 1,
        proofNonce: 'proof-nonce',
        parent: {
          sessionIdentity: opaque('parent-session'),
          messageIdentity: opaque('parent-message'),
        },
        providerId: 'openai',
        modelId: 'openai/gpt-5.4-mini',
        requiredMcpTools: ['agent-teams_message_send'],
        requireFreshRetainedHostProof: true,
      },
    },
    cwd: '/tmp/project',
    timeoutMs: 10_000,
  };
}

function strictLaunchResponse(body: OpenCodeLaunchTeamCommandBody): OpenCodeLaunchAttemptResponse {
  const opaque = (value: string) => `sha256:${stableHash(value)}` as const;
  const sessionIdentity = (id: string) =>
    `sha256:${createHash('sha256')
      .update(JSON.stringify({ kind: 'opencode-session', id }))
      .digest('hex')}` as const;
  const host = {
    hostKeyIdentity: opaque('host'),
    processId: 42,
    processStartedAtMs: 1_776_600_000_001,
    profileScopeIdentity: opaque('profile'),
  };
  return {
    launchAttempt: {
      contractVersion: 1 as const,
      attemptId: body.launchAttempt.attemptId,
      idempotencyKey: 'attemptId' as const,
      payloadHash: body.launchAttempt.payloadHash,
      generation: body.launchAttempt.generation,
      inputDigest: orchestratorVector.wire.response.launchAttempt.inputDigest,
      immutableDigest: orchestratorVector.wire.response.launchAttempt.immutableDigest,
      requestCorrelationDigest: body.launchAttempt.requestCorrelationDigest,
      outcome: 'succeeded' as const,
      phase: 'complete' as const,
      startedAt: 1_776_600_000_000,
      workDeadlineAt: 1_776_600_060_000,
      absoluteDeadlineAt: 1_776_600_075_000,
      cleanupReserveMs: 15_000,
      elapsedMs: 2_500,
      providerId: body.launchAttempt.providerId,
      modelId: body.launchAttempt.modelId,
      profilePurpose: 'launch_attempt',
      projectIdentity: opaque('project'),
      profileIdentity: host.profileScopeIdentity,
      configIdentity: opaque('config'),
      authIdentity: opaque('auth'),
      pluginPolicyIdentity: opaque('plugin'),
      cacheIdentity: opaque('cache'),
      binaryIdentity: opaque('binary'),
      retainedHostIdentity: host,
      processStartedAtMs: host.processStartedAtMs,
    },
    proof: {
      generation: body.launchAttempt.generation,
      attemptId: body.launchAttempt.attemptId,
      parent: body.launchAttempt.parent,
      providerId: body.launchAttempt.providerId,
      modelId: body.launchAttempt.modelId,
      retainedHostIdentity: host,
      observedMcpTools: [...body.launchAttempt.requiredMcpTools],
      nonceHash: createHash('sha256').update(body.launchAttempt.proofNonce, 'utf8').digest('hex'),
      sessionIdentity: opaque('proof-session'),
      promptMessageIdentity: opaque('proof-prompt'),
      assistantMessageIdentity: opaque('proof-assistant'),
      verifiedAt: 1_776_600_030_000,
      authorizationSource: 'fresh_live_attempt' as const,
      cacheUsed: false as const,
      requestCorrelationDigest: body.launchAttempt.requestCorrelationDigest,
    },
    members: {
      committed: body.members.map((member, index) => ({
        memberIdentity: member.memberIdentity,
        sessionIdentity: sessionIdentity(`session-${index}`),
        bootstrapMessageIdentity: opaque(`bootstrap-${index}`),
        commitIdentity: opaque(`commit-${index}`),
      })),
      failed: [],
      pending: [],
      cleanupPending: [],
    },
  };
}

function strictLaunchMembers(body: OpenCodeLaunchTeamCommandBody) {
  return Object.fromEntries(
    body.members.map((member, index) => [
      member.name,
      {
        sessionId: `session-${index}`,
        launchState: 'confirmed_alive' as const,
        model: body.selectedModel,
        evidence: [],
      },
    ])
  );
}

function strictLaunchBridgeResult(
  mutate?: (input: {
    body: OpenCodeLaunchTeamCommandBody;
    response: OpenCodeLaunchAttemptResponse;
  }) => void
): FakeBridgeExecutor['resultFactory'] {
  return ({ body, options }) => {
    const launchBody = body as unknown as OpenCodeLaunchTeamCommandBody;
    const response = strictLaunchResponse(launchBody);
    mutate?.({ body: launchBody, response });
    return bridgeSuccess({
      requestId: options.requestId,
      data: {
        runId: launchBody.runId,
        idempotencyKey: body.preconditions.idempotencyKey,
        runtimeStoreManifestHighWatermark: 10,
        members: strictLaunchMembers(launchBody),
        launchAttempt: response,
      },
    });
  };
}

function makeStrictLaunchPartial(
  response: OpenCodeLaunchAttemptResponse,
  body: OpenCodeLaunchTeamCommandBody
): void {
  response.launchAttempt.outcome = 'partial';
  response.launchAttempt.phase = 'cleanup';
  response.members.committed = response.members.committed.slice(0, 1);
  response.members.failed = [
    {
      memberIdentity: body.members[1]!.memberIdentity,
      failure: {
        code: 'rate_limited',
        origin: 'provider',
        retryDisposition: 'backoff',
        retryable: true,
        phase: 'member_materialize',
        sideEffectsStarted: false,
      },
    },
  ];
  response.members.continuationToken = 'opaque-continuation-token';
  response.failure = {
    code: 'deadline_after_partial',
    origin: 'deadline',
    retryDisposition: 'continuation',
    retryable: true,
    phase: 'member_materialize',
    sideEffectsStarted: true,
  };
}

function buildContinuationInput(
  input: Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0],
  generation: number,
  continuationToken = 'opaque-continuation-token'
): Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0] {
  const continuation = structuredClone(input);
  const body = continuation.body as OpenCodeLaunchTeamCommandBody;
  body.launchAttempt.generation = generation;
  body.launchAttempt.proofNonce = stableHash({
    attemptId: body.launchAttempt.attemptId,
    generation,
  });
  body.launchAttempt.continuationToken = continuationToken;
  return continuation;
}

function createProvisioningLaunchHarness(
  adapter: OpenCodeTeamRuntimeAdapter,
  previousLaunchState: TeamRuntimeLaunchInput['previousLaunchState'] = null
): {
  input: Parameters<typeof runOpenCodeTeamRuntimeAdapterLaunch>[0];
  ports: OpenCodeRuntimeAdapterLaunchPorts;
  cancel(): void;
  runtimeOwner(): { runId: string; providerId: string; cwd?: string } | undefined;
  clearPrimaryLane: ReturnType<typeof vi.fn>;
} {
  let provisioningRun: string | undefined;
  let cancelled = false;
  let runtimeOwner:
    | Parameters<OpenCodeRuntimeAdapterLaunchPorts['setRuntimeAdapterRun']>[1]
    | undefined;
  const clearPrimaryLane = vi.fn(async () => true);
  const members: TeamCreateRequest['members'] = [
    { name: 'alice', role: 'teammate', providerId: 'opencode' },
    { name: 'bob', role: 'teammate', providerId: 'opencode' },
  ];
  const input: Parameters<typeof runOpenCodeTeamRuntimeAdapterLaunch>[0] = {
    adapter,
    request: {
      teamName: 'team-a',
      cwd: '/tmp/project',
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      model: 'openai/gpt-5.4-mini',
      members,
    },
    members,
    prompt: '',
    onProgress: vi.fn(),
  };
  const ports: OpenCodeRuntimeAdapterLaunchPorts = {
    randomUUID: () => 'run-1',
    nowIso: () => '2026-04-21T12:00:00.000Z',
    getStopAllTeamsGeneration: () => 0,
    getStopTeamGeneration: () => 0,
    getRuntimeAdapterRun: () => runtimeOwner,
    stopOpenCodeRuntimeAdapterTeam: async () => undefined,
    getProvisioningRun: () => provisioningRun,
    getRuntimeAdapterProgress: () => undefined,
    isCancellableRuntimeAdapterProgress: () => false,
    cancelRuntimeAdapterProvisioning: async () => undefined,
    recordCancelledOpenCodeRuntimeAdapterLaunch: () => ({ runId: 'cancelled-run' }),
    setProvisioningRun: (_teamName, runId) => {
      provisioningRun = runId;
    },
    setRuntimeAdapterProgress: (progress) => progress,
    resetTeamScopedTransientStateForNewRun: () => undefined,
    readLaunchState: async () => previousLaunchState,
    clearPersistedLaunchState: async () => undefined,
    getTeamsBasePath: () => '/tmp/test-teams',
    migrateLegacyOpenCodeRuntimeState: async () => undefined,
    upsertOpenCodeRuntimeLaneIndexEntry: async () => undefined,
    getOpenCodeRuntimeLaunchCwd: (cwd) => cwd,
    setOpenCodeRuntimeActiveRunManifest: async () => undefined,
    isCancelledRuntimeAdapterRunId: () => cancelled,
    consumeCancelledRuntimeAdapterRunId: () => {
      const wasCancelled = cancelled;
      cancelled = false;
      return wasCancelled;
    },
    clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: clearPrimaryLane,
    persistOpenCodeRuntimeAdapterLaunchResult: async (result) => ({ result }),
    launchFailureArtifacts: { write: async () => undefined },
    syncOpenCodeRuntimeToolApprovals: () => undefined,
    clearOpenCodeRuntimeLaneStorage: async () => undefined,
    deleteRuntimeOwnershipIfCurrent: (_teamName, runId) => {
      if (runtimeOwner?.runId === runId) runtimeOwner = undefined;
    },
    setRuntimeAdapterRun: (_teamName, owner) => {
      runtimeOwner = owner;
    },
    setAliveRunId: () => undefined,
    invalidateRuntimeSnapshotCaches: () => undefined,
    deleteProvisioningRunIfCurrent: (_teamName, runId) => {
      if (provisioningRun === runId) provisioningRun = undefined;
    },
    emitTeamProcessChange: () => undefined,
  };
  return {
    input,
    ports,
    cancel: () => {
      cancelled = true;
    },
    runtimeOwner: () => runtimeOwner,
    clearPrimaryLane,
  };
}

function createProductionAdapter(
  stateChangingCommands: OpenCodeStateChangingBridgeCommandService,
  rawBridge: FakeBridgeExecutor
): OpenCodeTeamRuntimeAdapter {
  return new OpenCodeTeamRuntimeAdapter(
    new OpenCodeReadinessBridge(rawBridge, {
      stateChangingCommands,
      launchTimeoutMs: 10_000,
    })
  );
}

function buildAdapterLaunchInput(): TeamRuntimeLaunchInput {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    cwd: '/tmp/project',
    providerId: 'opencode',
    model: 'openai/gpt-5.4-mini',
    skipPermissions: true,
    expectedMembers: ['alice', 'bob'].map((name) => ({
      name,
      providerId: 'opencode' as const,
      model: 'openai/gpt-5.4-mini',
      cwd: '/tmp/project',
    })),
    previousLaunchState: null,
  };
}

function buildPartialLaunchSnapshot(
  attempt: PersistedOpenCodeStrictLaunchAttempt
): NonNullable<TeamRuntimeLaunchInput['previousLaunchState']> {
  return {
    version: 3,
    teamName: 'team-a',
    updatedAt: '2026-04-21T12:00:01.000Z',
    launchPhase: 'active',
    expectedMembers: ['alice', 'bob'],
    teamLaunchState: 'partial_pending',
    summary: {
      confirmedCount: 1,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 1,
    },
    members: {
      alice: persistedSnapshotMember('alice', 'confirmed_alive'),
      bob: persistedSnapshotMember('bob', 'runtime_pending_bootstrap'),
    },
    openCodeStrictLaunchAttempt: attempt,
  };
}

function persistedSnapshotMember(
  name: string,
  launchState: 'confirmed_alive' | 'runtime_pending_bootstrap'
) {
  return {
    name,
    launchState,
    agentToolAccepted: launchState === 'confirmed_alive',
    runtimeAlive: launchState === 'confirmed_alive',
    bootstrapConfirmed: launchState === 'confirmed_alive',
    hardFailure: false,
    lastEvaluatedAt: '2026-04-21T12:00:01.000Z',
    diagnostics: [],
  };
}

function readyOpenCodeLaunchReadiness(): OpenCodeTeamLaunchReadiness {
  return {
    state: 'ready',
    launchAllowed: true,
    modelId: 'openai/gpt-5.4-mini',
    availableModels: ['openai/gpt-5.4-mini'],
    opencodeVersion: '1.0.0',
    installMethod: 'brew',
    binaryPath: '/usr/local/bin/opencode',
    hostHealthy: true,
    appMcpConnected: true,
    requiredToolsPresent: true,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: 'production_supported',
    missing: [],
    diagnostics: [],
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: '/experimental/tool/ids',
      observedMcpTools: [...REQUIRED_AGENT_TEAMS_APP_TOOL_IDS],
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
  };
}

function buildSendInput(
  settlementMode: 'observed' | 'acceptance',
  fileParts?: Array<{ type: 'file'; mime: string; url: string; filename: string }>
): Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0] {
  return {
    command: 'opencode.sendMessage',
    teamName: 'team-a',
    laneId: 'secondary:opencode:bob',
    runId: 'run-1',
    capabilitySnapshotId: null,
    behaviorFingerprint: null,
    body: {
      runId: 'run-1',
      laneId: 'secondary:opencode:bob',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/tmp/project',
      memberName: 'bob',
      text: 'hello',
      messageId: 'msg-1',
      settlementMode,
      ...(fileParts ? { fileParts } : {}),
    },
    cwd: '/tmp/project',
    timeoutMs: 10_000,
  };
}

function buildStopInput(): Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0] {
  return {
    command: 'opencode.stopTeam',
    teamName: 'team-a',
    laneId: 'primary',
    runId: 'run-1',
    capabilitySnapshotId: 'cap-1',
    behaviorFingerprint: null,
    body: {
      runId: 'run-1',
      laneId: 'primary',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/tmp/project',
      reason: 'user_requested',
      force: true,
    },
    cwd: '/tmp/project',
    timeoutMs: 10_000,
  };
}

function bridgeSuccess(
  overrides: Partial<OpenCodeBridgeSuccess<unknown>> = {}
): OpenCodeBridgeSuccess<unknown> {
  return {
    ok: true,
    schemaVersion: 1,
    requestId: 'cmd-1',
    command: 'opencode.launchTeam',
    completedAt: '2026-04-21T12:00:01.000Z',
    durationMs: 1000,
    runtime: {
      providerId: 'opencode',
      binaryPath: '/usr/local/bin/opencode',
      binaryFingerprint: 'bin-1',
      version: '1.0.0',
      capabilitySnapshotId: 'cap-1',
    },
    diagnostics: [],
    data: {
      runId: 'run-1',
      idempotencyKey: 'key-1',
      runtimeStoreManifestHighWatermark: 10,
    },
    ...overrides,
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
      opencodeAppManagedBootstrapContractVersion: OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
      openCodeLaunchAttemptContract: 1,
      openCodeLaunchRequestCorrelationContract: 1,
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

function buildHandshakeWithAcceptedCommands(
  input: {
    client: OpenCodeBridgePeerIdentity;
    server: OpenCodeBridgePeerIdentity;
  },
  acceptedCommands: OpenCodeBridgeHandshake['acceptedCommands']
): OpenCodeBridgeHandshake {
  const withoutHash: Omit<OpenCodeBridgeHandshake, 'identityHash'> = {
    schemaVersion: 1,
    requestId: 'handshake-1',
    client: input.client,
    server: input.server,
    agreedProtocolVersion: 1,
    acceptedCommands,
    serverTime: '2026-04-21T12:00:00.000Z',
  };

  return {
    ...withoutHash,
    identityHash: createOpenCodeBridgeHandshakeIdentityHash(withoutHash),
  };
}

class FakeBridgeExecutor implements OpenCodeBridgeCommandExecutor {
  calls: Array<{
    command: OpenCodeBridgeCommandName;
    body: { prompt: string; preconditions: { idempotencyKey: string; commandLeaseId?: string } };
    options: Parameters<OpenCodeBridgeCommandExecutor['execute']>[2];
  }> = [];
  resultFactory: (input: {
    command: OpenCodeBridgeCommandName;
    body: { prompt: string; preconditions: { idempotencyKey: string; commandLeaseId?: string } };
    options: Parameters<OpenCodeBridgeCommandExecutor['execute']>[2];
  }) => OpenCodeBridgeResult<unknown> = ({ body, options }) =>
    bridgeSuccess({
      requestId: options.requestId,
      data: {
        runId: 'run-1',
        idempotencyKey: body.preconditions.idempotencyKey,
        runtimeStoreManifestHighWatermark: 10,
      },
    });

  async execute<TBody, TData>(
    command: OpenCodeBridgeCommandName,
    body: TBody,
    options: Parameters<OpenCodeBridgeCommandExecutor['execute']>[2]
  ): Promise<OpenCodeBridgeResult<TData>> {
    const call = {
      command,
      body: body as {
        prompt: string;
        preconditions: { idempotencyKey: string; commandLeaseId?: string };
      },
      options,
    };
    const dispatch = () => {
      this.calls.push(call);
      const result = this.resultFactory(call) as OpenCodeBridgeResult<TData>;
      options.onInvocationDispatched?.();
      return result;
    };
    return options.invocationAuthority ? options.invocationAuthority.invoke(dispatch) : dispatch();
  }
}

class FakeHandshakePort implements OpenCodeBridgeHandshakePort {
  constructor(public nextHandshake: OpenCodeBridgeHandshake) {}

  async handshake(): Promise<OpenCodeBridgeHandshake> {
    return this.nextHandshake;
  }
}

class FakeManifestReader implements RuntimeStoreManifestReader {
  manifest: RuntimeStoreManifestEvidence = {
    highWatermark: 10,
    activeRunId: 'run-1',
    capabilitySnapshotId: 'cap-1',
  };

  async read(): Promise<RuntimeStoreManifestEvidence> {
    return this.manifest;
  }
}

class FakeDiagnosticsSink implements OpenCodeStateChangingBridgeDiagnosticsSink {
  readonly append = vi.fn(async () => {});
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
