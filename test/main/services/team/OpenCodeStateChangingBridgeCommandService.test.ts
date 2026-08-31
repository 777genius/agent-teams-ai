import { OpenCodeRuntimeLaunchAuthorityWriter } from '@main/services/team/opencode/store/OpenCodeRuntimeLaunchAuthorityWriter';
import {
  getOpenCodeRuntimeManifestPath,
  OpenCodeRuntimeManifestEvidenceReader,
  readCommittedOpenCodeBootstrapSessionEvidence,
  setOpenCodeRuntimeActiveRunManifest,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createRuntimeStoreManifestStore,
  createRuntimeStoreReceiptStore,
  OPENCODE_RUNTIME_STORE_DESCRIPTORS,
  RuntimeStoreFileInspector,
  RuntimeStoreRecoveryPlanner,
} from '@main/services/team/opencode/store/RuntimeStoreManifest';
import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
  stampOpenCodeAppMcpTransportEvidenceIfMissing,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeBridgeHandshakeIdentityHash,
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
  OPEN_CODE_FILE_PARTS_CONTRACT_VERSION,
  type OpenCodeBridgeCommandName,
  type OpenCodeBridgeHandshake,
  type OpenCodeBridgePeerIdentity,
  type OpenCodeBridgeResult,
  type OpenCodeBridgeSuccess,
  type RuntimeStoreManifestEvidence,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
  OpenCodeBridgeCommandLeaseError,
  type OpenCodeBridgeCommandLeaseStore,
  type OpenCodeBridgeCommandLedger,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import { OpenCodeBridgeCommandHandshakePort } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import {
  type OpenCodeBridgeCommandExecutor,
  type OpenCodeBridgeHandshakePort,
  type OpenCodeLaunchAuthorityWriter,
  OpenCodeStateChangingBridgeCommandService,
  type OpenCodeStateChangingBridgeDiagnosticsSink,
  resolveOpenCodeBridgeLeaseAcquireTimeoutMs,
  type RuntimeStoreManifestReader,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';

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
  let launchAuthorityWriter: OpenCodeLaunchAuthorityWriter;
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
    launchAuthorityWriter = { publish: vi.fn(async () => {}) };
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

  it('publishes validated launch authority before completion and preserves it through bootstrap, transport and stop', async () => {
    const teamsBasePath = path.join(tempDir, 'teams');
    const laneId = 'secondary:opencode:alice';
    const scope = { teamsBasePath, teamName: 'team-a', laneId, runId: 'run-1' };
    await setOpenCodeRuntimeActiveRunManifest(scope); // Normal provisioning reserves only the run.
    const manifestPath = getOpenCodeRuntimeManifestPath(teamsBasePath, scope.teamName, laneId);
    const manifestStore = createRuntimeStoreManifestStore({
      filePath: manifestPath,
      teamName: scope.teamName,
    });
    const ports = createDefaultOpenCodeRuntimeBootstrapEvidencePorts({ teamsBasePath });
    const bootstrap = {
      teamName: scope.teamName,
      laneId,
      runId: scope.runId,
      memberName: 'alice',
      runtimeSessionId: 'session-alice',
      observedAt: now.toISOString(),
    };
    await commitOpenCodeRuntimeBootstrapSessionEvidence(bootstrap, ports);
    expect(await manifestStore.read()).toMatchObject({
      activeRunId: 'run-1',
      activeCapabilitySnapshotId: null,
    });
    const reader = new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath });
    const authorityWriter = new OpenCodeRuntimeLaunchAuthorityWriter({ teamsBasePath });
    const service = createService({
      manifestReader: reader,
      launchAuthorityWriter: authorityWriter,
    });
    bridge.resultFactory = ({ command, body, options }) =>
      bridgeSuccess({
        command,
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          expectedBehaviorFingerprint: 'a'.repeat(64),
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    const launch = buildLaunchInput();
    launch.laneId = laneId;
    await expect(service.execute(launch)).resolves.toMatchObject({ ok: true });
    expect(await reader.read(scope.teamName, laneId)).toMatchObject({
      capabilitySnapshotId: 'cap-1',
    });
    expect((await manifestStore.read()).entries[0]?.capabilitySnapshotId).toBeNull(); // No retroactive proof promotion.
    await commitOpenCodeRuntimeBootstrapSessionEvidence(
      { ...bootstrap, memberName: 'bob', runtimeSessionId: 'session-bob' },
      ports
    );
    const session = (await readCommittedOpenCodeBootstrapSessionEvidence(scope)).sessions.find(
      (entry) => entry.memberName === 'bob'
    )!;
    ports.getCurrentAgentTeamsMcpHttpTransportEvidence = () => ({
      schemaVersion: 1,
      transport: 'httpStream',
      host: '127.0.0.1',
      port: 19000,
      endpoint: '/mcp',
      url: 'http://127.0.0.1:19000/mcp',
      urlHash: 'sandbox-transport',
      generation: 1,
      observedAt: now.toISOString(),
    });
    await stampOpenCodeAppMcpTransportEvidenceIfMissing(session, ports);
    const persisted = await manifestStore.read();
    expect(persisted).toMatchObject({
      activeRunId: 'run-1',
      activeCapabilitySnapshotId: 'cap-1',
      activeBehaviorFingerprint: 'a'.repeat(64),
    });
    expect(persisted.entries[0]).toMatchObject({
      capabilitySnapshotId: 'cap-1',
      behaviorFingerprint: 'a'.repeat(64),
    });
    const sessionDescriptor = OPENCODE_RUNTIME_STORE_DESCRIPTORS.find(
      (entry) => entry.schemaName === 'opencode.sessionStore'
    )!;
    const directory = path.dirname(manifestPath);
    const planner = new RuntimeStoreRecoveryPlanner(
      [sessionDescriptor],
      manifestStore,
      createRuntimeStoreReceiptStore({
        filePath: path.join(directory, 'opencode-runtime-receipts.json'),
      }),
      new RuntimeStoreFileInspector(directory)
    );
    await expect(
      planner.buildPlan({
        teamName: scope.teamName,
        expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: 'cap-1',
        expectedBehaviorFingerprint: 'a'.repeat(64),
      })
    ).resolves.toMatchObject({ readinessImpact: 'none', diagnostics: [] });
    const stop = buildStopInput();
    stop.laneId = laneId;
    stop.capabilitySnapshotId = null;
    stop.body = { ...(stop.body as object), laneId, expectedCapabilitySnapshotId: null };
    await expect(service.execute(stop)).resolves.toMatchObject({ ok: true });
    expect(handshakePort.calls.at(-1)).toMatchObject({
      expectedCapabilitySnapshotId: 'cap-1',
      laneId,
    });
    // A later run cannot inherit authority, and an old callback cannot rewrite its files or binding.
    await setOpenCodeRuntimeActiveRunManifest({ ...scope, runId: 'run-2' });
    expect(await manifestStore.read()).toMatchObject({
      activeRunId: 'run-2',
      activeCapabilitySnapshotId: null,
      activeBehaviorFingerprint: null,
    });
    const oldSessionBytes = await fs.readFile(
      path.join(directory, sessionDescriptor.relativePath),
      'utf8'
    );
    await expect(commitOpenCodeRuntimeBootstrapSessionEvidence(bootstrap, ports)).rejects.toThrow(
      'active lane run'
    );
    expect(await fs.readFile(path.join(directory, sessionDescriptor.relativePath), 'utf8')).toBe(
      oldSessionBytes
    );
    await expect(
      authorityWriter.publish({
        teamName: scope.teamName,
        laneId,
        runId: 'run-1',
        capabilitySnapshotId: 'cap-1',
        behaviorFingerprint: 'a'.repeat(64),
      })
    ).rejects.toThrow('active lane run');
  });

  it('keeps a successful runtime launch uncertain when publishing authority fails', async () => {
    vi.mocked(launchAuthorityWriter.publish).mockRejectedValue(new Error('active run changed'));
    const service = createService();
    const result = await service.execute(buildLaunchInput());
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'contract_violation',
        retryable: false,
        message: expect.stringContaining('reconcile before retry'),
      },
      diagnostics: [expect.objectContaining({ type: 'opencode_bridge_unknown_outcome' })],
    });
    expect(await ledger.list()).toMatchObject([{ status: 'unknown_after_timeout' }]);
    await expect(service.execute(buildLaunchInput())).rejects.toThrow(
      'must be reconciled before retry'
    );
    expect(bridge.calls).toHaveLength(1);
  });

  it('keeps post-effect uncertainty when ledger and diagnostic storage also fail', async () => {
    vi.mocked(launchAuthorityWriter.publish).mockRejectedValue(new Error('disk unavailable'));
    vi.spyOn(ledger, 'markUnknownAfterTimeout').mockRejectedValue(new Error('disk unavailable'));
    vi.spyOn(diagnostics, 'append').mockRejectedValue(new Error('disk unavailable'));
    const service = createService();
    await expect(service.execute(buildLaunchInput())).resolves.toMatchObject({
      ok: false,
      error: { retryable: false },
      diagnostics: [expect.objectContaining({ type: 'opencode_bridge_unknown_outcome' })],
    });
    expect(await ledger.list()).toMatchObject([{ status: 'started' }]);
    await expect(service.execute(buildLaunchInput())).rejects.toThrow('already started');
    expect(bridge.calls).toHaveLength(1);
  });

  it.each([true, false])(
    'forwards exact launch model and approval scope to the handshake (%s)',
    async (skipPermissions) => {
      const input = buildLaunchInput();
      input.body = { ...(input.body as object), selectedModel: 'openai/gpt-5.4', skipPermissions };
      await createService().execute(input);
      expect(handshakePort.calls[0]).toMatchObject({
        selectedModel: 'openai/gpt-5.4',
        toolApprovalMode: skipPermissions ? 'auto' : 'manual',
        teamId: 'team-a',
        laneId: null,
        cwd: '/tmp/project',
        expectedCapabilitySnapshotId: 'cap-1',
      });
    }
  );

  it.each(['wrong-model-snapshot', 'wrong-approval-snapshot'])(
    'rejects %s before any launch effect',
    async (capabilitySnapshotId) => {
      handshakePort.nextHandshake = buildHandshake({
        client: clientIdentity,
        server: peerIdentity('agent_teams_orchestrator', { capabilitySnapshotId }),
      });
      const input = buildLaunchInput();
      input.body = {
        ...(input.body as object),
        selectedModel: 'openai/gpt-5.4',
        skipPermissions: false,
      };
      await expect(createService().execute(input)).rejects.toThrow('capability snapshot mismatch');
      expect(bridge.calls).toHaveLength(0);
      await expect(ledger.list()).resolves.toEqual([]);
      await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
    }
  );

  it('serializes selected profile and exact lane identity onto the handshake wire', async () => {
    bridge.resultFactory = ({ options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        command: 'opencode.handshake',
        data: handshakePort.nextHandshake,
      });
    const port = new OpenCodeBridgeCommandHandshakePort({ bridge, clientIdentity });
    await port.handshake({
      requiredCommand: 'opencode.launchTeam',
      expectedRunId: 'run-1',
      expectedCapabilitySnapshotId: 'cap-1',
      expectedManifestHighWatermark: 10,
      cwd: '/tmp/project',
      teamId: 'team-a',
      laneId: 'primary',
      selectedModel: 'openai/gpt-5.4',
      toolApprovalMode: 'manual',
    });
    expect(bridge.calls[0]).toMatchObject({
      command: 'opencode.handshake',
      body: {
        teamId: 'team-a',
        laneId: 'primary',
        selectedModel: 'openai/gpt-5.4',
        toolApprovalMode: 'manual',
        expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: 'cap-1',
      },
      options: { cwd: '/tmp/project' },
    });
  });

  it('binds stop to the persisted lane manifest without guessing the project latest model', async () => {
    const input = buildStopInput();
    input.capabilitySnapshotId = null;
    input.body = { ...(input.body as object), expectedCapabilitySnapshotId: null };
    bridge.resultFactory = ({ command, body, options }) =>
      bridgeSuccess({
        command,
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    await createService().execute(input);
    expect(handshakePort.calls[0]).toMatchObject({
      expectedCapabilitySnapshotId: 'cap-1',
      teamId: 'team-a',
      laneId: 'primary',
    });
    expect(handshakePort.calls[0]).not.toHaveProperty('selectedModel');
    expect(bridge.calls[0].body).toMatchObject({
      expectedCapabilitySnapshotId: 'cap-1',
      preconditions: { expectedCapabilitySnapshotId: 'cap-1' },
    });
  });

  it('binds two lanes in one project to their own persisted snapshots', async () => {
    const readManifest = vi
      .spyOn(manifestReader, 'read')
      .mockResolvedValueOnce({
        highWatermark: 10,
        activeRunId: 'run-1',
        capabilitySnapshotId: 'cap-1',
      })
      .mockResolvedValueOnce({
        highWatermark: 10,
        activeRunId: 'run-1',
        capabilitySnapshotId: 'cap-2',
      });
    let activeCapability = 'cap-1';
    bridge.resultFactory = ({ command, body, options }) =>
      bridgeSuccess({
        command,
        requestId: options.requestId,
        runtime: {
          ...peerIdentity('agent_teams_orchestrator').runtime,
          capabilitySnapshotId: activeCapability,
        },
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
        },
      });
    const service = createService();
    for (const laneId of ['lane-a', 'lane-b']) {
      activeCapability = laneId === 'lane-a' ? 'cap-1' : 'cap-2';
      handshakePort.nextHandshake = buildHandshake({
        client: clientIdentity,
        server: peerIdentity('agent_teams_orchestrator', {
          capabilitySnapshotId: activeCapability,
        }),
      });
      const input = buildStopInput();
      input.laneId = laneId;
      input.capabilitySnapshotId = null;
      input.body = { ...(input.body as object), laneId, expectedCapabilitySnapshotId: null };
      await service.execute(input);
    }
    expect(readManifest.mock.calls).toEqual([
      ['team-a', 'lane-a'],
      ['team-a', 'lane-b'],
    ]);
    expect(handshakePort.calls).toMatchObject([
      { laneId: 'lane-a', expectedCapabilitySnapshotId: 'cap-1' },
      { laneId: 'lane-b', expectedCapabilitySnapshotId: 'cap-2' },
    ]);
    expect(bridge.calls.map((call) => call.body)).toMatchObject([
      { laneId: 'lane-a', expectedCapabilitySnapshotId: 'cap-1' },
      { laneId: 'lane-b', expectedCapabilitySnapshotId: 'cap-2' },
    ]);
  });

  it('reconciles with independent app/runtime counters while retaining exact run and capability fences', async () => {
    clientIdentity.bridgeProtocol.supportedCommands.push('opencode.reconcileTeam');
    const server = peerIdentity('agent_teams_orchestrator', {
      runtimeStoreManifestHighWatermark: 0,
    });
    server.bridgeProtocol.supportedCommands.push('opencode.reconcileTeam');
    handshakePort.nextHandshake = buildHandshakeWithAcceptedCommands(
      { client: clientIdentity, server },
      ['opencode.reconcileTeam']
    );
    bridge.resultFactory = ({ command, body, options }) =>
      bridgeSuccess({
        command,
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 0,
        },
      });
    const input = { ...buildStopInput(), command: 'opencode.reconcileTeam' as const };
    const service = createService();
    await expect(service.execute(input)).resolves.toMatchObject({ ok: true });
    expect(handshakePort.calls[0]).toMatchObject({
      expectedManifestHighWatermark: null,
      expectedRunId: 'run-1',
      expectedCapabilitySnapshotId: 'cap-1',
    });
    await expect(service.execute({ ...input, runId: 'stale-run' })).rejects.toThrow(
      'persisted lane'
    );
    await expect(service.execute({ ...input, capabilitySnapshotId: 'wrong-cap' })).rejects.toThrow(
      'persisted lane'
    );
    expect(bridge.calls).toHaveLength(1);
  });

  it('marks an empty persisted-lane stop explicitly on handshake and dispatch', async () => {
    manifestReader.manifest = { highWatermark: 0, activeRunId: null, capabilitySnapshotId: null };
    const input = buildStopInput();
    input.capabilitySnapshotId = null;
    input.body = { ...(input.body as object), expectedCapabilitySnapshotId: null };
    bridge.resultFactory = ({ command, body, options }) =>
      bridgeSuccess({
        command,
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 0,
        },
      });
    await createService().execute(input);
    expect(handshakePort.calls[0]).toMatchObject({
      allowEmptyLaneStop: true,
      expectedCapabilitySnapshotId: null,
    });
    expect(bridge.calls[0].body).toMatchObject({
      allowEmptyLaneStop: true,
      expectedCapabilitySnapshotId: null,
    });
  });

  it.each([
    'wrong-run',
    'wrong-caller-snapshot',
    'wrong-body-snapshot',
    'missing-snapshot',
    'wrong-body-lane',
    'forged-empty-stop',
  ])('rejects lifecycle %s before handshake or mutation', async (failure) => {
    const input = buildStopInput();
    if (failure === 'wrong-run') input.runId = 'another-run';
    if (failure === 'wrong-caller-snapshot') input.capabilitySnapshotId = 'another-cap';
    if (failure === 'wrong-body-snapshot')
      input.body = { ...(input.body as object), expectedCapabilitySnapshotId: 'another-cap' };
    if (failure === 'forged-empty-stop')
      input.body = { ...(input.body as object), allowEmptyLaneStop: true };
    if (failure === 'missing-snapshot') manifestReader.manifest.capabilitySnapshotId = null;
    if (failure === 'wrong-body-lane')
      input.body = { ...(input.body as object), laneId: 'other-lane' };
    await expect(createService().execute(input)).rejects.toThrow(/persisted lane/);
    expect(handshakePort.calls).toHaveLength(0);
    expect(bridge.calls).toHaveLength(0);
    await expect(ledger.list()).resolves.toEqual([]);
  });

  it('blocks an old orchestrator before state-changing launch dispatch', async () => {
    const server = peerIdentity('agent_teams_orchestrator');
    delete server.bridgeProtocol.expectedBehaviorFingerprintSchemaVersion;
    handshakePort.nextHandshake = buildHandshake({ client: clientIdentity, server });

    await expect(createService().execute(buildLaunchInput())).rejects.toThrow(
      'expected behavior fingerprint schema version 2 is required'
    );
    expect(bridge.calls).toHaveLength(0);
    await expect(ledger.list()).resolves.toEqual([]);
  });

  it('rejects missing launch fingerprint before handshake or dispatch', async () => {
    const input = buildLaunchInput();
    input.behaviorFingerprint = null;

    await expect(createService().execute(input)).rejects.toThrow(
      'requires a lowercase SHA-256 behavior fingerprint'
    );
    expect(handshakePort.calls).toHaveLength(0);
    expect(bridge.calls).toHaveLength(0);
  });

  it('dispatches and hashes a changed launch digest as a distinct request', async () => {
    bridge.resultFactory = ({ body, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          expectedBehaviorFingerprint: body.preconditions.expectedBehaviorFingerprint,
        },
      });
    const service = createService();
    await service.execute(buildLaunchInput());
    const changed = buildLaunchInput();
    changed.behaviorFingerprint = 'b'.repeat(64);
    changed.body = {
      ...(changed.body as Record<string, unknown>),
      expectedBehaviorFingerprint: changed.behaviorFingerprint,
    };

    await service.execute(changed);

    expect(bridge.calls).toHaveLength(2);
    expect(bridge.calls[1].body.preconditions.idempotencyKey).not.toBe(
      bridge.calls[0].body.preconditions.idempotencyKey
    );
    const entries = await ledger.list();
    expect(entries[1]?.requestHash).not.toBe(entries[0]?.requestHash);
  });

  it('keeps a committed launch with a mismatched fingerprint echo reconcilable', async () => {
    bridge.resultFactory = ({ body, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          expectedBehaviorFingerprint: 'f'.repeat(64),
        },
      });

    const result = await createService().execute(buildLaunchInput());

    expect(result).toMatchObject({
      ok: false,
      requestId: 'cmd-1',
      error: {
        kind: 'contract_violation',
        message: 'OpenCode launch result behavior fingerprint mismatch',
        retryable: false,
      },
    });
    expect(bridge.calls).toHaveLength(1);
    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'unknown_after_timeout',
      retryable: false,
      lastError: 'OpenCode launch result behavior fingerprint mismatch',
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_bridge_unknown_outcome',
        message: 'OpenCode bridge command outcome must be reconciled before retry',
      })
    );
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
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
          expectedBehaviorFingerprint: 'a'.repeat(64),
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
          expectedBehaviorFingerprint: 'a'.repeat(64),
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

  it('adds preconditions, commits ledger, and releases lease on success', async () => {
    bridge.resultFactory = ({ body, options }) =>
      bridgeSuccess({
        requestId: options.requestId,
        data: {
          runId: 'run-1',
          idempotencyKey: body.preconditions.idempotencyKey,
          runtimeStoreManifestHighWatermark: 10,
          expectedBehaviorFingerprint: 'a'.repeat(64),
        },
      });
    const service = createService();

    const result = await service.execute(buildLaunchInput());

    expect(result.ok).toBe(true);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].options).toMatchObject({ requestId: 'cmd-1' });
    expect(bridge.calls[0].body).toMatchObject({
      prompt: 'launch',
      preconditions: {
        handshakeIdentityHash: handshakePort.nextHandshake.identityHash,
        expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: 'cap-1',
        expectedBehaviorFingerprint: 'a'.repeat(64),
        expectedManifestHighWatermark: 10,
        commandLeaseId: 'lease-1',
        idempotencyKey: expect.stringMatching(
          /^opencode:opencode\.launchTeam:team-a:no-lane:run-1:/
        ),
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
    await expect(leaseStore.getActive('team-a')).resolves.toBeNull();
  });

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
      launchAuthorityWriter,
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
        ...(buildLaunchInput().body as Record<string, unknown>),
        capabilitySnapshotRecoveryAttemptId: 'opencode-capability-recovery-test',
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
          expectedBehaviorFingerprint: 'a'.repeat(64),
          diagnostics: [
            {
              code: 'opencode_capability_snapshot_recovery',
              severity: 'warning',
              message: 'Accepted fresh OpenCode capability snapshot after app recovery attempt.',
            },
          ],
        },
      });
    const service = createService();

    const result = await service.execute({
      ...buildLaunchInput(),
      body: {
        ...(buildLaunchInput().body as Record<string, unknown>),
        capabilitySnapshotRecoveryAttemptId: 'opencode-capability-recovery-test',
      },
    });

    expect(result.ok).toBe(true);
    expect(launchAuthorityWriter.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilitySnapshotId: 'cap-2',
        behaviorFingerprint: 'a'.repeat(64),
      })
    );
    const idempotencyKey = bridge.calls[0].body.preconditions.idempotencyKey;
    await expect(ledger.getByIdempotencyKey(idempotencyKey)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  function createService(
    overrides: {
      leaseAcquireTimeoutMs?: number;
      leaseAcquireRetryDelayMs?: number;
      manifestReader?: RuntimeStoreManifestReader;
      launchAuthorityWriter?: OpenCodeLaunchAuthorityWriter;
    } = {}
  ): OpenCodeStateChangingBridgeCommandService {
    return new OpenCodeStateChangingBridgeCommandService({
      expectedClientIdentity: clientIdentity,
      handshakePort,
      leaseStore,
      ledger,
      bridge,
      manifestReader,
      launchAuthorityWriter,
      diagnostics,
      requestIdFactory: () => 'cmd-1',
      diagnosticIdFactory: () => 'diag-1',
      clock: () => now,
      ...overrides,
    });
  }
});

function buildLaunchInput(): Parameters<OpenCodeStateChangingBridgeCommandService['execute']>[0] {
  const expectedBehaviorFingerprint = 'a'.repeat(64);
  return {
    command: 'opencode.launchTeam',
    teamName: 'team-a',
    runId: 'run-1',
    capabilitySnapshotId: 'cap-1',
    behaviorFingerprint: expectedBehaviorFingerprint,
    body: { prompt: 'launch', expectedBehaviorFingerprint },
    cwd: '/tmp/project',
    timeoutMs: 10_000,
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
      expectedBehaviorFingerprint: 'a'.repeat(64),
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
      expectedBehaviorFingerprintSchemaVersion:
        OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
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
    body: {
      prompt: string;
      preconditions: {
        idempotencyKey: string;
        commandLeaseId?: string;
        expectedBehaviorFingerprint: string | null;
      };
    };
    options: { cwd: string; timeoutMs: number; requestId?: string };
  }> = [];
  resultFactory: (input: {
    command: OpenCodeBridgeCommandName;
    body: {
      prompt: string;
      preconditions: {
        idempotencyKey: string;
        commandLeaseId?: string;
        expectedBehaviorFingerprint: string | null;
      };
    };
    options: { cwd: string; timeoutMs: number; requestId?: string };
  }) => OpenCodeBridgeResult<unknown> = ({ body, options }) =>
    bridgeSuccess({
      requestId: options.requestId,
      data: {
        runId: 'run-1',
        idempotencyKey: body.preconditions.idempotencyKey,
        runtimeStoreManifestHighWatermark: 10,
        expectedBehaviorFingerprint: body.preconditions.expectedBehaviorFingerprint,
      },
    });

  async execute<TBody, TData>(
    command: OpenCodeBridgeCommandName,
    body: TBody,
    options: { cwd: string; timeoutMs: number; requestId?: string }
  ): Promise<OpenCodeBridgeResult<TData>> {
    const call = {
      command,
      body: body as {
        prompt: string;
        preconditions: {
          idempotencyKey: string;
          commandLeaseId?: string;
          expectedBehaviorFingerprint: string | null;
        };
      },
      options,
    };
    this.calls.push(call);
    return this.resultFactory(call) as OpenCodeBridgeResult<TData>;
  }
}

class FakeHandshakePort implements OpenCodeBridgeHandshakePort {
  readonly calls: unknown[] = [];
  constructor(public nextHandshake: OpenCodeBridgeHandshake) {}

  async handshake(input?: unknown): Promise<OpenCodeBridgeHandshake> {
    this.calls.push(input);
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
