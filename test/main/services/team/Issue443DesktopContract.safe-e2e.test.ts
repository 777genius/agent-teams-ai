// @vitest-environment node
import {
  createDegradedProviderStatus,
  mergeProviderStatusDisplayEvidence,
} from '@main/services/runtime/providerStatusCheckContract';
import {
  createOpenCodeBridgeHandshakeIdentityHash,
  OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import { OpenCodeReadinessBridge } from '@main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { OpenCodeStateChangingBridgeCommandService } from '@main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import {
  createOpenCodeCanonicalProjectPathFingerprint,
  createOpenCodeExecutionProofHash,
  createOpenCodeExpectedBehaviorFingerprint,
} from '@main/services/team/opencode/readiness/OpenCodeExpectedBehaviorFingerprint';
import { OpenCodeTeamRuntimeAdapter } from '@main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import goldenFixture from '../../../fixtures/team/opencode/expected-behavior-fingerprint-v2.json';

import type {
  OpenCodeBridgeCommandName,
  OpenCodeBridgePeerIdentity,
  OpenCodeBridgeResult,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type {
  OpenCodeBridgeCommandLeaseStore,
  OpenCodeBridgeCommandLedger,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import type { OpenCodeBridgeCommandExecutor } from '@main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { OpenCodeExecutionProof } from '@main/services/team/opencode/readiness/OpenCodeExecutionProof';
import type { OpenCodeExpectedBehaviorTuple } from '@main/services/team/opencode/readiness/OpenCodeExpectedBehaviorFingerprint';
import type { OpenCodeTeamLaunchReadiness } from '@main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';
import type { TeamRuntimeLaunchInput } from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { CliProviderStatus } from '@shared/types';

const execCli = vi.fn();
vi.mock('@main/utils/childProcess', () => ({ execCli: (...args: unknown[]) => execCli(...args) }));
vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnvBestEffort: () => Promise.resolve({}),
}));
vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: () => Promise.resolve({ env: {}, connectionIssues: {} }),
  getAggregateProviderStatusStoredCredentialAllowlist: () => [],
  getProviderStatusStoredCredentialAllowlist: () => [],
}));
vi.mock('@main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    enrichProviderStatus: (provider: unknown) => Promise.resolve(provider),
    enrichProviderStatuses: (providers: unknown) => Promise.resolve(providers),
  },
}));

const PROJECT = '/disposable/project';
const MODEL = 'deepinfra/deepseek-ai/DeepSeek-V3.2';
const NOW = '2026-08-29T00:00:00.000Z';
const golden = goldenFixture.cases[0];
const { name: _goldenName, ...goldenEvidence } = golden;

interface CapturedLaunchBody extends Record<string, unknown> {
  runId: string;
  expectedBehaviorFingerprint: string;
  preconditions: {
    expectedBehaviorFingerprint: string | null;
    idempotencyKey: string;
  };
}
describe('issue #443 Desktop-owned fake E2E contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes passive status/catalog to the selected provider with zero real effects', async () => {
    const unrelatedHungProvider = deferred<never>();
    execCli.mockImplementation((_binary, args) => {
      const provider = providerArg(args as string[]);
      if (provider === 'cursor') return unrelatedHungProvider.promise;
      expect(provider).toBe('opencode');
      return Promise.resolve(commandResult(providerPayload('opencode/big-pickle')));
    });
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const selected = await new ClaudeMultimodelBridgeService().getProviderStatus(
      '/fake/bridge',
      'opencode',
      undefined,
      { projectPath: PROJECT }
    );

    expect(selected).toMatchObject({
      providerId: 'opencode',
      statusCheckOutcome: 'authoritative',
      modelCatalog: { defaultLaunchModel: 'opencode/big-pickle' },
    });
    expect(execCli).toHaveBeenCalledTimes(2);
    expect(execCli.mock.calls.every((call) => providerArg(call[1]) === 'opencode')).toBe(true);
  });
  it('retains a timed-out catalog for display but revokes launch authority', () => {
    const prior = providerStatus();
    const merged = mergeProviderStatusDisplayEvidence(
      createDegradedProviderStatus(prior, new Error('catalog timeout')),
      prior
    );

    expect(merged).toMatchObject({
      statusCheckOutcome: 'transient_error',
      models: prior.models,
      modelCatalog: { status: 'stale', models: prior.modelCatalog?.models },
      capabilities: { teamLaunch: false },
    });
    expect(
      mergeProviderStatusDisplayEvidence({ ...prior, statusCheckOutcome: undefined }, prior)
        .capabilities.teamLaunch
    ).toBe(false);
  });
  it('does not let an older catalog generation overwrite the newer result', async () => {
    const firstCatalog = deferred<ReturnType<typeof commandResult>>();
    let summaryCalls = 0;
    let catalogCalls = 0;
    execCli.mockImplementation((_binary, args) => {
      const isSummary = (args as string[]).includes('--summary');
      if (isSummary) {
        summaryCalls += 1;
        return Promise.resolve(
          commandResult(providerPayload(summaryCalls === 1 ? 'old/model' : 'new/model', false))
        );
      }
      catalogCalls += 1;
      return catalogCalls === 1
        ? firstCatalog.promise
        : Promise.resolve(commandResult(providerPayload('new/model')));
    });
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');
    const service = new ClaudeMultimodelBridgeService();
    const first = service.getProviderStatus('/fake/bridge', 'opencode', undefined, {
      projectPath: PROJECT,
    });
    await vi.waitFor(() => expect(catalogCalls).toBe(1));
    const second = service.getProviderStatus('/fake/bridge', 'opencode', undefined, {
      projectPath: PROJECT,
    });
    firstCatalog.resolve(commandResult(providerPayload('old/model')));

    const [oldGeneration, newGeneration] = await Promise.all([first, second]);
    expect(oldGeneration.modelCatalog?.defaultLaunchModel).not.toBe('old/model');
    expect(newGeneration.modelCatalog?.defaultLaunchModel).toBe('new/model');
  });
  it.each([
    [
      'missing evidence',
      (proof: OpenCodeExecutionProof) => ({ ...proof, expectedBehaviorEvidence: undefined }),
    ],
    ['missing provider evidence', proofWith({ modelProviderId: undefined })],
    ['wrong provider evidence', proofWith({ modelProviderId: 'custom' })],
    ['missing model evidence', proofWith({ fullModelId: undefined })],
    ['wrong model evidence', proofWith({ fullModelId: 'deepinfra/other' })],
    ['missing project evidence', proofWith({ canonicalProjectPathFingerprint: undefined })],
    ['wrong project evidence', proofWith({ canonicalProjectPathFingerprint: '0'.repeat(64) })],
    ['missing digest', proofWith({ expectedBehaviorFingerprint: undefined }, false)],
    ['wrong digest', proofWith({ expectedBehaviorFingerprint: 'f'.repeat(64) }, false)],
    [
      'wrong proofHash',
      (proof: OpenCodeExecutionProof) => ({ ...proof, proofHash: '9'.repeat(64) }),
    ],
    ['missing proofHash', (proof: OpenCodeExecutionProof) => ({ ...proof, proofHash: undefined })],
  ])('blocks dispatch for %s', async (_label, changeProof) => {
    const harness = contractHarness({ proof: changeProof(validProof()) });
    const result = await harness.adapter.launch(launchInput('run-invalid'));

    expect(result.teamLaunchState).not.toBe('clean_success');
    expect(harness.launchCalls).toHaveLength(0);
  });
  it.each([
    ['missing capability', { readinessCapability: null }],
    ['wrong capability', { handshakeCapability: 'cap-wrong' }],
    ['missing v2 behavior evidence', { fingerprintSchemaVersion: undefined }],
    ['old v2 behavior evidence', { fingerprintSchemaVersion: 1 }],
  ])('blocks state-changing dispatch for %s', async (_label, changes) => {
    const harness = contractHarness(changes);
    const result = await harness.adapter.launch(launchInput('run-invalid-handshake'));

    expect(result.teamLaunchState).not.toBe('clean_success');
    expect(harness.launchCalls).toHaveLength(0);
  });
  it('computes the shared golden and sends the valid canonical digest in both launch bindings', async () => {
    const harness = contractHarness();
    const result = await harness.adapter.launch(launchInput('run-valid'));

    expect(result.teamLaunchState).toBe('clean_success');
    expect(createOpenCodeExpectedBehaviorFingerprint(golden)).toBe(
      golden.expectedBehaviorFingerprint
    );
    expect(golden.expectedBehaviorFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const expectedFingerprint = validProof().expectedBehaviorEvidence as {
      expectedBehaviorFingerprint: string;
    };
    expect(harness.launchCalls[0]?.body.expectedBehaviorFingerprint).toBe(
      expectedFingerprint.expectedBehaviorFingerprint
    );
    expect(harness.launchCalls[0]?.body.preconditions.expectedBehaviorFingerprint).toBe(
      expectedFingerprint.expectedBehaviorFingerprint
    );

    const goldenHarness = contractHarness();
    await expect(
      goldenHarness.stateChanging.execute({
        command: 'opencode.launchTeam',
        teamName: 'golden-team',
        runId: 'golden-run',
        capabilitySnapshotId: 'cap-1',
        behaviorFingerprint: golden.expectedBehaviorFingerprint,
        body: {
          runId: 'golden-run',
          expectedBehaviorFingerprint: golden.expectedBehaviorFingerprint,
        },
        cwd: PROJECT,
        timeoutMs: 1_000,
      })
    ).resolves.toMatchObject({ ok: true });
    expect(goldenHarness.launchCalls[0]?.body.expectedBehaviorFingerprint).toBe(
      golden.expectedBehaviorFingerprint
    );
    expect(goldenHarness.launchCalls[0]?.body.preconditions.expectedBehaviorFingerprint).toBe(
      golden.expectedBehaviorFingerprint
    );
  });
  it.each([
    ['prior requestId', { secondResponseRequestId: 'request-1' }],
    ['wrong requestId', { secondResponseRequestId: 'request-wrong' }],
    ['different fingerprint', { secondResponseFingerprint: 'f'.repeat(64) }],
  ])('uses fresh requestIds and rejects a second launch with %s', async (_label, changes) => {
    const harness = contractHarness(changes);
    expect((await harness.adapter.launch(launchInput('run-1', 'team-1'))).teamLaunchState).toBe(
      'clean_success'
    );
    const second = await harness.adapter.launch(launchInput('run-2', 'team-2'));

    expect(harness.launchCalls.map((call) => call.requestId)).toEqual(['request-1', 'request-2']);
    expect(second.teamLaunchState).not.toBe('clean_success');
  });
});
function contractHarness(
  changes: {
    proof?: OpenCodeExecutionProof;
    readinessCapability?: string | null;
    handshakeCapability?: string | null;
    fingerprintSchemaVersion?: number;
    secondResponseRequestId?: string;
    secondResponseFingerprint?: string;
  } = {}
) {
  const launchCalls: Array<{ requestId: string; body: CapturedLaunchBody }> = [];
  const client = peer(
    'claude_team',
    'cap-1',
    OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION
  );
  let requestNumber = 0;
  const bridge: OpenCodeBridgeCommandExecutor = {
    async execute<TBody, TData>(
      command: OpenCodeBridgeCommandName,
      body: TBody,
      options: { requestId?: string }
    ) {
      if (command === 'opencode.readiness') {
        return success(command, 'readiness-1', readiness(changes.proof ?? validProof()), {
          capabilitySnapshotId:
            changes.readinessCapability === undefined ? 'cap-1' : changes.readinessCapability,
        }) as OpenCodeBridgeResult<TData>;
      }
      if (command !== 'opencode.launchTeam') throw new Error(`Unexpected fake command ${command}`);
      const requestId = options.requestId ?? '';
      const request = body as CapturedLaunchBody;
      launchCalls.push({ requestId, body: request });
      const callNumber = launchCalls.length;
      return success(
        command,
        callNumber === 2 && changes.secondResponseRequestId
          ? changes.secondResponseRequestId
          : requestId,
        launchData(
          request,
          callNumber === 2 && changes.secondResponseFingerprint
            ? changes.secondResponseFingerprint
            : request.expectedBehaviorFingerprint
        )
      ) as OpenCodeBridgeResult<TData>;
    },
  };
  const handshakePort = {
    async handshake(input: { expectedRunId: string | null }) {
      const server = peer(
        'agent_teams_orchestrator',
        changes.handshakeCapability === undefined ? 'cap-1' : changes.handshakeCapability,
        changes.fingerprintSchemaVersion === undefined && 'fingerprintSchemaVersion' in changes
          ? undefined
          : (changes.fingerprintSchemaVersion ??
              OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION),
        input.expectedRunId
      );
      const unsigned = {
        schemaVersion: 1 as const,
        requestId: 'handshake-1',
        client,
        server,
        agreedProtocolVersion: 1,
        acceptedCommands: ['opencode.launchTeam'] as OpenCodeBridgeCommandName[],
        serverTime: NOW,
      };
      return { ...unsigned, identityHash: createOpenCodeBridgeHandshakeIdentityHash(unsigned) };
    },
  };
  const ledger = {
    begin: async () => 'started' as const,
    markCompleted: async () => undefined,
    markFailed: async () => undefined,
    markUnknownAfterTimeout: async () => undefined,
  } as unknown as OpenCodeBridgeCommandLedger;
  const leaseStore = {
    acquire: async (input: Record<string, unknown>) => ({
      ...input,
      leaseId: `lease-${requestNumber + 1}`,
      laneId: input.laneId ?? null,
      holderPeer: 'claude_team' as const,
      acquiredAt: NOW,
      expiresAt: '2099-08-29T00:00:00.000Z',
      state: 'active' as const,
    }),
    release: async () => undefined,
  } as unknown as OpenCodeBridgeCommandLeaseStore;
  const stateChanging = new OpenCodeStateChangingBridgeCommandService({
    expectedClientIdentity: client,
    handshakePort,
    leaseStore,
    ledger,
    bridge,
    manifestReader: {
      async read() {
        return { highWatermark: 0, activeRunId: null, capabilitySnapshotId: 'cap-1' };
      },
    },
    requestIdFactory: () => `request-${++requestNumber}`,
    clock: () => new Date(NOW),
  });
  const readinessBridge = new OpenCodeReadinessBridge(bridge, {
    stateChangingCommands: stateChanging,
  });
  return {
    adapter: new OpenCodeTeamRuntimeAdapter(readinessBridge),
    stateChanging,
    launchCalls,
  };
}
function validProof(): OpenCodeExecutionProof {
  const expectedBehaviorEvidence = {
    ...goldenEvidence,
    canonicalProjectPathFingerprint: createOpenCodeCanonicalProjectPathFingerprint(PROJECT),
  };
  expectedBehaviorEvidence.expectedBehaviorFingerprint =
    createOpenCodeExpectedBehaviorFingerprint(expectedBehaviorEvidence);
  const unsigned = {
    schemaVersion: 1 as const,
    providerId: 'opencode' as const,
    modelId: MODEL,
    projectPath: PROJECT,
    profileRootKey: 'fake-profile',
    projectBehaviorFingerprint: golden.projectBehaviorFingerprint,
    managedConfigFingerprint: golden.effectiveConfigFingerprint,
    managedAuthFingerprint: golden.effectiveSelectedAuthFingerprint,
    binaryPath: '/fake/opencode',
    binaryFingerprint: 'fake-binary',
    opencodeVersion: '1.0.0',
    capabilitySnapshotId: 'cap-1',
    credentialMode: 'api' as const,
    reusable: false,
    verifiedAt: NOW,
    expiresAt: '2099-08-29T00:00:00.000Z',
    expectedBehaviorEvidence,
  };
  return { ...unsigned, proofHash: createOpenCodeExecutionProofHash(unsigned) };
}
function mutateEvidence(
  proof: OpenCodeExecutionProof,
  changes: Record<string, unknown>,
  rehash = true
): OpenCodeExecutionProof {
  const evidence = { ...(proof.expectedBehaviorEvidence as Record<string, unknown>), ...changes };
  if (
    rehash &&
    typeof evidence.modelProviderId === 'string' &&
    typeof evidence.fullModelId === 'string'
  ) {
    evidence.expectedBehaviorFingerprint = createOpenCodeExpectedBehaviorFingerprint(
      evidence as unknown as OpenCodeExpectedBehaviorTuple
    );
  }
  const { proofHash: _old, ...unsigned } = { ...proof, expectedBehaviorEvidence: evidence };
  return { ...unsigned, proofHash: createOpenCodeExecutionProofHash(unsigned) };
}
function proofWith(changes: Record<string, unknown>, rehash = true) {
  return (proof: OpenCodeExecutionProof) => mutateEvidence(proof, changes, rehash);
}
function readiness(proof: OpenCodeExecutionProof): OpenCodeTeamLaunchReadiness {
  return {
    state: 'ready',
    launchAllowed: true,
    modelId: MODEL,
    availableModels: [MODEL],
    opencodeVersion: '1.0.0',
    installMethod: 'unknown',
    binaryPath: '/fake/opencode',
    hostHealthy: true,
    appMcpConnected: true,
    requiredToolsPresent: true,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: 'supported',
    missing: [],
    diagnostics: [],
    executionProof: proof,
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: 'execution',
      observedMcpTools: ['agent'],
      runtimeStoreReadinessReason: null,
    },
  };
}
function launchInput(runId: string, teamName = 'team-fake'): TeamRuntimeLaunchInput {
  return {
    runId,
    teamName,
    cwd: PROJECT,
    providerId: 'opencode',
    model: MODEL,
    skipPermissions: true,
    previousLaunchState: null,
    expectedMembers: [
      { name: 'alice', role: 'Developer', providerId: 'opencode', model: MODEL, cwd: PROJECT },
    ],
  };
}
function launchData(body: CapturedLaunchBody, fingerprint: string) {
  return {
    runId: body.runId,
    teamLaunchState: 'ready',
    members: {
      alice: {
        sessionId: 'fake-session',
        launchState: 'confirmed_alive',
        model: MODEL,
        evidence: [],
      },
    },
    warnings: [],
    diagnostics: [],
    expectedBehaviorFingerprint: fingerprint,
    idempotencyKey: body.preconditions.idempotencyKey,
    runtimeStoreManifestHighWatermark: 0,
    durableCheckpoints: [
      'required_tools_proven',
      'delivery_ready',
      'member_ready',
      'run_ready',
    ].map((name) => ({ name, observedAt: NOW })),
  };
}
function success(
  command: OpenCodeBridgeCommandName,
  requestId: string,
  data: unknown,
  runtime: { capabilitySnapshotId?: string | null } = {}
) {
  return {
    ok: true as const,
    schemaVersion: 1 as const,
    requestId,
    command,
    completedAt: NOW,
    durationMs: 0,
    runtime: {
      providerId: 'opencode' as const,
      binaryPath: '/fake/opencode',
      binaryFingerprint: 'fake-binary',
      version: '1.0.0',
      capabilitySnapshotId:
        'capabilitySnapshotId' in runtime ? (runtime.capabilitySnapshotId ?? null) : 'cap-1',
    },
    diagnostics: [],
    data,
  };
}
function peer(
  peerName: OpenCodeBridgePeerIdentity['peer'],
  capabilitySnapshotId: string | null,
  schemaVersion?: number,
  activeRunId: string | null = null
): OpenCodeBridgePeerIdentity {
  return {
    schemaVersion: 1,
    peer: peerName,
    appVersion: 'fake',
    gitSha: null,
    buildId: 'fake',
    bridgeProtocol: {
      minVersion: 1,
      currentVersion: 1,
      supportedCommands: ['opencode.launchTeam'],
      opencodeAppManagedBootstrapContractVersion: OPEN_CODE_APP_MANAGED_BOOTSTRAP_CONTRACT_VERSION,
      ...(schemaVersion === undefined
        ? {}
        : { expectedBehaviorFingerprintSchemaVersion: schemaVersion }),
    },
    runtime: {
      providerId: 'opencode',
      binaryPath: '/fake/opencode',
      binaryFingerprint: 'fake-binary',
      version: '1.0.0',
      capabilitySnapshotId,
      runtimeStoreManifestHighWatermark: 0,
      activeRunId,
    },
    featureFlags: { opencodeTeamLaunch: true, opencodeStateChangingCommands: true },
  };
}
function providerStatus(): CliProviderStatus {
  return providerPayload('opencode/big-pickle') as unknown as CliProviderStatus;
}
function providerPayload(model: string, withCatalog = true) {
  return {
    providerId: 'opencode',
    supported: true,
    authenticated: true,
    authMethod: 'builtin_free',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    canLoginFromUi: false,
    statusMessage: null,
    detailMessage: null,
    selectedBackendId: 'opencode',
    resolvedBackendId: 'opencode',
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    models: [model],
    capabilities: { teamLaunch: true, oneShot: false, extensions: {} },
    backend: { kind: 'opencode', label: 'OpenCode' },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
    modelCatalog: withCatalog
      ? {
          schemaVersion: 1,
          providerId: 'opencode',
          source: 'static-fallback',
          status: 'ready',
          fetchedAt: NOW,
          staleAt: '2099-01-01T00:00:00.000Z',
          defaultModelId: model,
          defaultLaunchModel: model,
          models: [
            {
              id: model,
              launchModel: model,
              displayName: model,
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              inputModalities: ['text'],
              supportsPersonality: false,
              isDefault: true,
              upgrade: false,
              source: 'static-fallback',
            },
          ],
          diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
        }
      : undefined,
  };
}
function commandResult(provider: Record<string, unknown>) {
  return {
    stdout: JSON.stringify({ schemaVersion: 2, providers: { opencode: provider } }),
    stderr: '',
    exitCode: 0,
  };
}
function providerArg(args: unknown): string | undefined {
  const values = args as string[];
  return values[values.indexOf('--provider') + 1];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
