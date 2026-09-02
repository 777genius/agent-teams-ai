// @vitest-environment node
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDegradedProviderStatus,
  mergeProviderStatusDisplayEvidence,
} from '@main/services/runtime/providerStatusCheckContract';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { OpenCodeBridgeCommandClient } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import {
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import {
  createOpenCodeBridgeClientIdentity,
  OpenCodeBridgeCommandHandshakePort,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { OpenCodeReadinessBridge } from '@main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { OpenCodeStateChangingBridgeCommandService } from '@main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import {
  createOpenCodeExpectedBehaviorFingerprint,
} from '@main/services/team/opencode/readiness/OpenCodeExpectedBehaviorFingerprint';
import { OpenCodeRuntimeLaunchAuthorityWriter } from '@main/services/team/opencode/store/OpenCodeRuntimeLaunchAuthorityWriter';
import {
  OpenCodeRuntimeManifestEvidenceReader,
  setOpenCodeRuntimeActiveRunManifest,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { OpenCodeTeamRuntimeAdapter } from '@main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let createLaunchGuard: typeof import('@renderer/components/team/dialogs/providerLaunchAuthority').createLaunchGuard;

// Renderer account/store modules read localStorage during module evaluation,
// while this contract suite intentionally runs in Vitest's Node environment.
const localStorageState = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => localStorageState.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageState.set(key, String(value)); },
  removeItem: (key: string) => { localStorageState.delete(key); },
  clear: () => { localStorageState.clear(); },
  key: (index: number) => [...localStorageState.keys()][index] ?? null,
  get length() { return localStorageState.size; },
});

beforeAll(async () => {
  ({ createLaunchGuard } = await import('@renderer/components/team/dialogs/providerLaunchAuthority'));
});

import {
  RUNTIME_PROVIDER_MANAGEMENT_CANCEL_MODEL_LOAD,
  RUNTIME_PROVIDER_MANAGEMENT_MODELS,
} from '../../../../src/features/runtime-provider-management/contracts';
import {
  createRuntimeProviderManagementFeature,
  registerRuntimeProviderManagementIpc,
} from '../../../../src/features/runtime-provider-management/main';
import { AgentTeamsRuntimeProviderManagementCliClient } from '../../../../src/features/runtime-provider-management/main/infrastructure/AgentTeamsRuntimeProviderManagementCliClient';
import { createRuntimeProviderManagementBridge } from '../../../../src/features/runtime-provider-management/preload';

import type {
  OpenCodeBridgeCommandLeaseStore,
  OpenCodeBridgeCommandLedger,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import type { OpenCodeExpectedBehaviorTuple } from '@main/services/team/opencode/readiness/OpenCodeExpectedBehaviorFingerprint';
import type { TeamRuntimeLaunchInput } from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { CliProviderStatus } from '@shared/types';
import type { IpcMain, IpcRenderer } from 'electron';

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnvBestEffort: () => Promise.resolve({}),
}));
vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildPassiveProviderStatusCliEnv: () => ({
    env: fakeExecutableEnv(),
    connectionIssues: {},
    providerArgs: [],
  }),
  buildProviderAwareCliEnv: () => Promise.resolve({
    env: fakeExecutableEnv(),
    connectionIssues: {},
  }),
  getAggregateProviderStatusStoredCredentialAllowlist: () => [],
  getProviderStatusStoredCredentialAllowlist: () => [],
}));
vi.mock('@main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    applyPassiveProviderStatusConnectionEnv: (env: NodeJS.ProcessEnv) => Promise.resolve(env),
    enrichProviderStatus: (provider: unknown) => Promise.resolve(provider),
    enrichProviderStatuses: (providers: unknown) => Promise.resolve(providers),
  },
}));

const MODEL = 'deepinfra/deepseek-ai/DeepSeek-V3.2';
const NOW = '2026-08-29T00:00:00.000Z';
const FIXTURE_SOURCE = path.join(
  process.cwd(),
  'test/main/services/team/Issue443DesktopContractFakeExecutable.mjs'
);
const sandboxes: string[] = [];

function fakeExecutableEnv(): NodeJS.ProcessEnv {
  return {
    PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    ISSUE443_FAKE_SCENARIO: process.env.ISSUE443_FAKE_SCENARIO,
    ISSUE443_FAKE_TRACE_FILE: process.env.ISSUE443_FAKE_TRACE_FILE,
  };
}

interface FakeTrace {
  kind:
    | 'provider-status'
    | 'provider-models-request'
    | 'provider-models'
    | 'rejected'
    | 'bridge';
  pid: number;
  argv: string[];
  cwd: string;
  inputPath?: string;
  outputPath?: string | null;
  inputRaw?: string;
  envelope?: Record<string, unknown> & { body: Record<string, unknown>; command: string };
  outputRaw: string;
  proofValidation?: {
    ok: boolean;
    independentlyExpected?: string;
    membersObservedBeforeProof?: boolean;
  } | null;
  sideEffectCommitted?: boolean;
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => rm(sandbox, { recursive: true })));
  delete process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
  ClaudeBinaryResolver.clearCache();
});

describe('issue #443 Desktop real child-process wire contract', () => {
  it('authorizes model-only OpenCode status only with scoped model evidence', async () => {
    const fake = await createFake('valid');
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const passive = await new ClaudeMultimodelBridgeService().getProviderStatus(
      fake.executable,
      'opencode',
      undefined,
      { projectPath: fake.project }
    );
    expect(passive).toMatchObject({
      providerId: 'opencode',
      statusCheckOutcome: 'model_only',
      modelCatalog: null,
      capabilities: { teamLaunch: false },
    });
    expect(
      createLaunchGuard(['opencode'], new Map([['opencode', passive]]), {
        selectedModels: [],
        scopedStatusBySourceId: new Map(),
      }).blocked(true)
    ).toBe(true);

    const scopedResponse = await providerManagementDesktopHarness().bridge.loadModels({
      runtimeId: 'opencode',
      providerId: 'deepinfra',
      projectPath: fake.project,
      requestGroupId: 'issue443-scoped-authority',
    });
    expect(scopedResponse.error).toBeUndefined();
    const scopedStatus: CliProviderStatus = {
      ...passive,
      models: [MODEL],
      modelAvailability: [{ modelId: MODEL, status: 'available' }],
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: NOW,
        staleAt: '2099-01-01T00:00:00.000Z',
        defaultModelId: MODEL,
        defaultLaunchModel: MODEL,
        models: [
          {
            id: MODEL,
            launchModel: MODEL,
            displayName: MODEL,
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'app-server',
          },
        ],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };
    expect(
      createLaunchGuard(['opencode'], new Map([['opencode', passive]]), {
        selectedModels: [MODEL],
        scopedStatusBySourceId: new Map([['deepinfra', scopedStatus]]),
      }).blocked(true)
    ).toBe(false);

    const traces = await fake.traces();
    expect(traces.map((trace) => trace.kind)).toEqual(['provider-status', 'provider-models']);
    expect(traces.every((trace) => trace.cwd === fake.project)).toBe(true);
    expect(traces[0].argv).toEqual([
      'runtime',
      'status',
      '--json',
      '--provider',
      'opencode',
      '--summary',
    ]);
    expect(traces[1].argv).toContain('deepinfra');
    assertProcessesExited(traces);
  });

  it('routes selected provider pagination through the production preload and IPC path', async () => {
    const fake = await createFake('paginated-catalog');
    const desktop = providerManagementDesktopHarness();
    const firstPage = await desktop.bridge.loadModels({
      runtimeId: 'opencode',
      providerId: 'deepinfra',
      projectPath: fake.project,
      limit: 1,
      requestGroupId: 'issue443-pagination',
    });
    expect(firstPage.error).toBeUndefined();
    const nextCursor = firstPage.models?.nextCursor;
    expect(nextCursor).toBe('deepinfra-page-2');
    const secondPage = await desktop.bridge.loadModels({
      runtimeId: 'opencode',
      providerId: 'deepinfra',
      projectPath: fake.project,
      limit: 1,
      cursor: nextCursor,
      requestGroupId: 'issue443-pagination',
    });

    expect(firstPage.models?.models.map((model) => model.modelId)).toEqual([MODEL]);
    expect(secondPage.models?.models.map((model) => model.modelId)).toEqual([
      'deepinfra/deepseek-ai/DeepSeek-R1',
    ]);
    const traces = await fake.traces();
    expect(traces.map((trace) => trace.kind)).toEqual(['provider-models', 'provider-models']);
    expect(desktop.invokedChannels).toEqual([
      RUNTIME_PROVIDER_MANAGEMENT_MODELS,
      RUNTIME_PROVIDER_MANAGEMENT_MODELS,
    ]);
    expect(traces.map((trace) => trace.cwd)).toEqual([fake.project, fake.project]);
    expect(traces.map((trace) => trace.argv)).toEqual([
      [
        'runtime',
        'providers',
        'models',
        '--runtime',
        'opencode',
        '--provider',
        'deepinfra',
        '--json',
        '--limit',
        '1',
        '--project-path',
        fake.project,
      ],
      [
        'runtime',
        'providers',
        'models',
        '--runtime',
        'opencode',
        '--provider',
        'deepinfra',
        '--json',
        '--limit',
        '1',
        '--cursor',
        'deepinfra-page-2',
        '--project-path',
        fake.project,
      ],
    ]);
    expect(traces.some((trace) => trace.argv.includes('kiro'))).toBe(false);
    expect(traces.some((trace) => trace.argv.includes('cursor-acp'))).toBe(false);
    assertProcessesExited(traces);
  });

  it('cancels an old request group while a replacement group loads built-in OpenCode Zen', async () => {
    const fake = await createFake('slow-catalog');
    const desktop = providerManagementDesktopHarness();
    const slowDeepInfra = desktop.bridge.loadModels({
      runtimeId: 'opencode',
      providerId: 'deepinfra',
      projectPath: fake.project,
      requestGroupId: 'issue443-selected-provider-old',
    });
    await vi.waitFor(
      async () => {
        expect((await fake.traces()).filter((trace) => trace.kind === 'provider-models-request'))
          .toHaveLength(1);
      },
      { timeout: 5_000, interval: 25 }
    );

    const builtInPromise = desktop.bridge.loadModels({
      runtimeId: 'opencode',
      providerId: 'opencode',
      projectPath: fake.project,
      requestGroupId: 'issue443-selected-provider-new',
    });
    void desktop.bridge.cancelModelLoad({
      requestGroupId: 'issue443-selected-provider-old',
    });
    const [builtIn, superseded] = await Promise.all([builtInPromise, slowDeepInfra]);

    expect(superseded.error).toBeDefined();
    expect(builtIn.models).toMatchObject({
      providerId: 'opencode',
      defaultModelId: 'opencode/nemotron-3-super-free',
    });
    expect(builtIn.models?.models.map((model) => model.modelId)).toEqual([
      'opencode/nemotron-3-super-free',
    ]);
    const traces = await fake.traces();
    expect(traces.map((trace) => trace.kind)).toEqual([
      'provider-models-request',
      'provider-models',
    ]);
    expect(desktop.invokedChannels).toEqual([
      RUNTIME_PROVIDER_MANAGEMENT_MODELS,
      RUNTIME_PROVIDER_MANAGEMENT_MODELS,
      RUNTIME_PROVIDER_MANAGEMENT_CANCEL_MODEL_LOAD,
    ]);
    expect(traces.every((trace) => trace.cwd === fake.project)).toBe(true);
    expect(traces.map((trace) => trace.argv.slice(5, 8))).toEqual([
      ['--provider', 'deepinfra', '--json'],
      ['--provider', 'opencode', '--json'],
    ]);
    expect(traces.every((trace) => !trace.argv.includes('--request-group-id'))).toBe(true);
    assertProcessesExited(traces);
  });

  it('cancels the real provider process when its catalog scope disappears', async () => {
    const fake = await createFake('slow-catalog');
    const desktop = providerManagementDesktopHarness();
    const pending = desktop.bridge.loadModels({
      runtimeId: 'opencode',
      providerId: 'deepinfra',
      projectPath: fake.project,
      requestGroupId: 'issue443-closing-scope',
    });
    await vi.waitFor(
      async () => {
        expect((await fake.traces()).filter((trace) => trace.kind === 'provider-models-request'))
          .toHaveLength(1);
      },
      { timeout: 5_000, interval: 25 }
    );

    await expect(
      desktop.bridge.cancelModelLoad({ requestGroupId: 'issue443-closing-scope' })
    ).resolves.toEqual({ ok: true });
    expect((await pending).error).toBeDefined();

    const traces = await fake.traces();
    expect(traces.map((trace) => trace.kind)).toEqual(['provider-models-request']);
    assertProcessesExited(traces);
    expect(desktop.invokedChannels).toEqual([
      RUNTIME_PROVIDER_MANAGEMENT_MODELS,
      RUNTIME_PROVIDER_MANAGEMENT_CANCEL_MODEL_LOAD,
    ]);
  });

  it('crosses the real Desktop child boundary with exact v2 proof bindings and framing', async () => {
    const harness = await realContractHarness('valid');
    const result = await harness.launch(launchInput('run-valid', harness.fake.project));

    expect(result.teamLaunchState, JSON.stringify(result)).toBe('clean_success');
    expect(result.members.alice).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      runtimeAlive: true,
    });
    const traces = await harness.fake.traces();
    expect(traces.map((trace) => trace.envelope?.command)).toEqual([
      'opencode.readiness',
      'opencode.handshake',
      'opencode.launchTeam',
    ]);
    for (const trace of traces) {
      expect(trace.kind).toBe('bridge');
      expect(trace.cwd).toBe(harness.fake.project);
      expect(trace.argv).toEqual([
        'runtime',
        'opencode-command',
        '--json',
        '--input',
        trace.inputPath,
        '--output',
        trace.outputPath,
      ]);
      expect(trace.inputRaw).toBe(`${JSON.stringify(trace.envelope, null, 2)}\n`);
      expect(trace.outputRaw).toMatch(/^\{[^\n]+\}\n$/);
    }
    const readiness = traces[0].envelope?.body;
    expect(readiness).toEqual({
      projectPath: harness.fake.project,
      selectedModel: MODEL,
      requireExecutionProbe: true,
      skipPermissions: true,
    });
    const handshakeEnvelope = traces[1].envelope as unknown as {
      body: {
        requiredCommand: string;
        expectedRunId: string;
        expectedCapabilitySnapshotId: string;
        expectedManifestHighWatermark: number;
        client: { bridgeProtocol: { expectedBehaviorFingerprintSchemaVersion: number } };
      };
    };
    expect(handshakeEnvelope.body).toMatchObject({
      requiredCommand: 'opencode.launchTeam',
      expectedRunId: 'run-valid',
      expectedCapabilitySnapshotId: 'issue443-capability-v2',
      expectedManifestHighWatermark: 0,
      client: { bridgeProtocol: { expectedBehaviorFingerprintSchemaVersion: 2 } },
    });
    expect(JSON.parse(traces[1].outputRaw).data).toMatchObject({
      acceptedCommands: ['opencode.launchTeam'],
      server: {
        peer: 'agent_teams_orchestrator',
        bridgeProtocol: { expectedBehaviorFingerprintSchemaVersion: 2 },
      },
    });
    const launch = traces[2];
    const launchBody = launch.envelope?.body as {
      expectedBehaviorFingerprint: string;
      executionProof: { expectedBehaviorEvidence: OpenCodeExpectedBehaviorTuple };
      preconditions: { expectedBehaviorFingerprint: string };
    };
    const independentlyExpected = launch.proofValidation?.independentlyExpected;
    expect(independentlyExpected).toMatch(/^[0-9a-f]{64}$/);
    expect(createOpenCodeExpectedBehaviorFingerprint(launchBody.executionProof.expectedBehaviorEvidence)).toBe(
      independentlyExpected
    );
    expect(launchBody.expectedBehaviorFingerprint).toBe(independentlyExpected);
    expect(launchBody.preconditions.expectedBehaviorFingerprint).toBe(independentlyExpected);
    expect(JSON.parse(launch.outputRaw).data.expectedBehaviorFingerprint).toBe(independentlyExpected);
    expect(launch.proofValidation).toEqual({
      ok: true,
      independentlyExpected,
      membersObservedBeforeProof: false,
    });
    expect(launch.sideEffectCommitted).toBe(true);
    assertProcessesExited(traces);
    expect(await harness.fake.remainingBridgeFiles()).toEqual([]);
  });

  it.each([
    ['stale readiness proof', 'stale-proof', 0],
    ['handshake fingerprint v1', 'handshake-v1', 0],
  ] as const)('fails closed for %s', async (_label, scenario, expectedLaunches) => {
    const harness = await realContractHarness(scenario);
    const result = await harness.launch(launchInput(`run-${scenario}`, harness.fake.project));

    expect(result.teamLaunchState).not.toBe('clean_success');
    expect(result.members.alice).not.toMatchObject({ runtimeAlive: true, bootstrapConfirmed: true });
    const traces = await harness.fake.traces();
    expect(traces.filter((trace) => trace.envelope?.command === 'opencode.launchTeam')).toHaveLength(
      expectedLaunches
    );
    assertProcessesExited(traces);
  });

  it('retains a launch with a mismatched fingerprint echo for reconciliation', async () => {
    const harness = await realContractHarness('mismatch-echo');
    const result = await harness.launch(
      launchInput('run-mismatch-echo', harness.fake.project)
    );

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.members.alice).toMatchObject({
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    const traces = await harness.fake.traces();
    expect(traces.filter((trace) => trace.envelope?.command === 'opencode.launchTeam')).toHaveLength(
      1
    );
    expect(harness.ledger.markUnknownAfterTimeout).toHaveBeenCalledTimes(1);
    expect(harness.ledger.markFailed).not.toHaveBeenCalled();
    assertProcessesExited(traces);
  });

  it('keeps a committed launch pending when authority publication fails without redispatching', async () => {
    const harness = await realContractHarness('valid', new Error('fixture authority write failed'));
    const result = await harness.launch(launchInput('run-publication-failed', harness.fake.project));

    expect(result.teamLaunchState, JSON.stringify(result)).toBe('partial_pending');
    expect(result.members.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(harness.ledger.markUnknownAfterTimeout).toHaveBeenCalledTimes(1);
    expect(harness.ledger.markFailed).not.toHaveBeenCalled();
    expect(harness.ledger.markCompleted).not.toHaveBeenCalled();
    const traces = await harness.fake.traces();
    const launches = traces.filter((trace) => trace.envelope?.command === 'opencode.launchTeam');
    expect(launches).toHaveLength(1);
    expect(launches[0].sideEffectCommitted).toBe(true);
    assertProcessesExited(traces);
  });

  it('treats an unknown launch outcome as non-retryable without duplicating the side effect', async () => {
    const harness = await realContractHarness('unknown-outcome');
    const result = await harness.launch(launchInput('run-unknown', harness.fake.project));

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.members.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    const traces = await harness.fake.traces();
    const launchTraces = traces.filter(
      (trace) => trace.envelope?.command === 'opencode.launchTeam'
    );
    expect(launchTraces).toHaveLength(1);
    expect(launchTraces[0]).toMatchObject({
      outputRaw: '',
      sideEffectCommitted: true,
      proofValidation: { ok: true, membersObservedBeforeProof: false },
    });
    expect(traces.map((trace) => trace.envelope?.command)).toEqual([
      'opencode.readiness',
      'opencode.handshake',
      'opencode.launchTeam',
    ]);
    expect(harness.ledger.markUnknownAfterTimeout).toHaveBeenCalledTimes(1);
    expect(harness.ledger.markFailed).not.toHaveBeenCalled();
    expect(harness.ledger.begin).toHaveBeenCalledTimes(1);
    assertProcessesExited(traces);
    expect(await harness.fake.remainingBridgeFiles()).toEqual([]);
  });

  it('retains stale catalog display data while revoking launch authority', () => {
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
});

function providerManagementDesktopHarness() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
  } as unknown as IpcMain;
  registerRuntimeProviderManagementIpc(
    ipcMain,
    createRuntimeProviderManagementFeature({
      port: new AgentTeamsRuntimeProviderManagementCliClient(),
    })
  );

  const invokedChannels: string[] = [];
  const ipcRenderer = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      invokedChannels.push(channel);
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`No fake IPC handler registered for ${channel}`);
      }
      return handler({}, ...args);
    }),
  } as unknown as IpcRenderer;

  return {
    bridge: createRuntimeProviderManagementBridge(ipcRenderer),
    invokedChannels,
  };
}

async function realContractHarness(scenario: string, publicationFailure?: Error) {
  const fake = await createFake(scenario);
  const bridge = new OpenCodeBridgeCommandClient({
    binaryPath: fake.executable,
    tempDirectory: fake.bridgeTemp,
    requestIdFactory: sequentialIds('wire'),
    diagnosticIdFactory: sequentialIds('diagnostic'),
    clock: () => new Date(NOW),
    env: fakeExecutableEnv(),
  });
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: 'issue443-desktop-test',
    gitSha: '825b6881db4165eee2bbb98841c3469617ee5ddd',
    buildId: 'issue443-r141',
  });
  expect(clientIdentity.bridgeProtocol.expectedBehaviorFingerprintSchemaVersion).toBe(
    OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION
  );
  const ledger = {
    begin: vi.fn().mockResolvedValue('started'),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markUnknownAfterTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpenCodeBridgeCommandLedger & Record<string, ReturnType<typeof vi.fn>>;
  let leaseNumber = 0;
  const leaseStore = {
    acquire: vi.fn((input: Record<string, unknown>) => Promise.resolve({
      ...input,
      leaseId: `issue443-lease-${++leaseNumber}`,
      laneId: input.laneId ?? null,
      holderPeer: 'claude_team' as const,
      acquiredAt: NOW,
      expiresAt: '2099-01-01T00:00:00.000Z',
      state: 'active' as const,
    })),
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as OpenCodeBridgeCommandLeaseStore;
  const teamsBasePath = path.join(fake.sandbox, 'teams');
  const launchAuthorityWriter = new OpenCodeRuntimeLaunchAuthorityWriter({ teamsBasePath });
  if (publicationFailure) {
    vi.spyOn(launchAuthorityWriter, 'publish').mockRejectedValue(publicationFailure);
  }
  const stateChanging = new OpenCodeStateChangingBridgeCommandService({
    expectedClientIdentity: clientIdentity,
    handshakePort: new OpenCodeBridgeCommandHandshakePort({ bridge, clientIdentity, timeoutMs: 1_000 }),
    leaseStore,
    ledger,
    bridge,
    manifestReader: new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath }),
    launchAuthorityWriter,
    requestIdFactory: sequentialIds('state-change'),
    diagnosticIdFactory: sequentialIds('state-diagnostic'),
    clock: () => new Date(NOW),
  });
  const readiness = new OpenCodeReadinessBridge(bridge, {
    timeoutMs: 1_000,
    launchTimeoutMs: 1_000,
    stateChangingCommands: stateChanging,
  });
  const adapter = new OpenCodeTeamRuntimeAdapter(readiness);
  return {
    fake,
    ledger,
    async launch(input: TeamRuntimeLaunchInput) {
      const requestedLaneId = input.laneId?.trim();
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath,
        teamName: input.teamName,
        laneId: requestedLaneId && requestedLaneId.length > 0 ? requestedLaneId : 'primary',
        runId: input.runId,
      });
      return adapter.launch(input);
    },
  };
}

async function createFake(scenario: string) {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 'issue443-desktop-wire-')));
  sandboxes.push(sandbox);
  const project = path.join(sandbox, 'project');
  const bridgeTemp = path.join(sandbox, 'bridge-inputs');
  const executable = path.join(sandbox, 'issue443-fake-orchestrator');
  const traceFile = path.join(sandbox, `trace-${scenario}.ndjson`);
  await Promise.all([mkdir(project), mkdir(bridgeTemp)]);
  await copyFile(FIXTURE_SOURCE, executable);
  await chmod(executable, 0o700);
  process.env.ISSUE443_FAKE_SCENARIO = scenario;
  process.env.ISSUE443_FAKE_TRACE_FILE = traceFile;
  process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = executable;
  ClaudeBinaryResolver.clearCache();
  return {
    sandbox,
    project,
    bridgeTemp,
    executable,
    traceFile,
    async traces(): Promise<FakeTrace[]> {
      const raw = await readFile(traceFile, 'utf8').catch(() => '');
      return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeTrace);
    },
    remainingBridgeFiles: () => readdir(bridgeTemp),
  };
}

function launchInput(runId: string, project: string): TeamRuntimeLaunchInput {
  return {
    runId,
    teamName: 'issue443-fake-team',
    cwd: project,
    providerId: 'opencode',
    model: MODEL,
    skipPermissions: true,
    previousLaunchState: null,
    expectedMembers: [
      { name: 'alice', role: 'Developer', providerId: 'opencode', model: MODEL, cwd: project },
    ],
  };
}

function sequentialIds(prefix: string): () => string {
  let number = 0;
  return () => `${prefix}-${++number}`;
}

function assertProcessesExited(traces: FakeTrace[]): void {
  for (const pid of new Set(traces.map((trace) => trace.pid))) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
}

function providerStatus(): CliProviderStatus {
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
    models: [MODEL],
    capabilities: { teamLaunch: true, oneShot: false, extensions: {} },
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'static-fallback',
      status: 'ready',
      fetchedAt: NOW,
      staleAt: '2099-01-01T00:00:00.000Z',
      defaultModelId: MODEL,
      defaultLaunchModel: MODEL,
      models: [],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  } as unknown as CliProviderStatus;
}
