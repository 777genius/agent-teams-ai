// @vitest-environment node
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDegradedProviderStatus,
  mergeProviderStatusDisplayEvidence,
} from '@main/services/runtime/providerStatusCheckContract';
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
import { OpenCodeTeamRuntimeAdapter } from '@main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  OpenCodeBridgeCommandLeaseStore,
  OpenCodeBridgeCommandLedger,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import type { OpenCodeExpectedBehaviorTuple } from '@main/services/team/opencode/readiness/OpenCodeExpectedBehaviorFingerprint';
import type { TeamRuntimeLaunchInput } from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { CliProviderStatus } from '@shared/types';

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
  kind: 'provider-status' | 'bridge';
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
});

describe('issue #443 Desktop real child-process wire contract', () => {
  it('uses provider-scoped authoritative status through the disposable executable', async () => {
    const fake = await createFake('valid');
    const { ClaudeMultimodelBridgeService } =
      await import('@main/services/runtime/ClaudeMultimodelBridgeService');

    const selected = await new ClaudeMultimodelBridgeService().getProviderStatus(
      fake.executable,
      'opencode',
      undefined,
      { projectPath: fake.project }
    );

    expect(selected).toMatchObject({
      providerId: 'opencode',
      statusCheckOutcome: 'authoritative',
      modelCatalog: { defaultLaunchModel: MODEL },
      capabilities: { teamLaunch: true },
    });
    const traces = await fake.traces();
    expect(traces).toHaveLength(2);
    expect(traces.every((trace) => trace.kind === 'provider-status')).toBe(true);
    expect(traces.every((trace) => trace.cwd === fake.project)).toBe(true);
    expect(traces.map((trace) => trace.argv)).toEqual([
      ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
      ['runtime', 'status', '--json', '--provider', 'opencode'],
    ]);
    assertProcessesExited(traces);
  });

  it('crosses the real Desktop child boundary with exact v2 proof bindings and framing', async () => {
    const harness = await realContractHarness('valid');
    const result = await harness.adapter.launch(launchInput('run-valid', harness.fake.project));

    expect(result.teamLaunchState).toBe('clean_success');
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
    ['mismatched result fingerprint echo', 'mismatch-echo', 1],
  ] as const)('fails closed for %s', async (_label, scenario, expectedLaunches) => {
    const harness = await realContractHarness(scenario);
    const result = await harness.adapter.launch(launchInput(`run-${scenario}`, harness.fake.project));

    expect(result.teamLaunchState).not.toBe('clean_success');
    expect(result.members.alice).not.toMatchObject({ runtimeAlive: true, bootstrapConfirmed: true });
    const traces = await harness.fake.traces();
    expect(traces.filter((trace) => trace.envelope?.command === 'opencode.launchTeam')).toHaveLength(
      expectedLaunches
    );
    assertProcessesExited(traces);
  });

  it('treats an unknown launch outcome as non-retryable without duplicating the side effect', async () => {
    const harness = await realContractHarness('unknown-outcome');
    const result = await harness.adapter.launch(launchInput('run-unknown', harness.fake.project));

    expect(result.teamLaunchState).not.toBe('clean_success');
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
    expect(harness.ledger.markUnknownAfterTimeout).toHaveBeenCalledTimes(1);
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

async function realContractHarness(scenario: string) {
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
    acquire: vi.fn(async (input: Record<string, unknown>) => ({
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
  const stateChanging = new OpenCodeStateChangingBridgeCommandService({
    expectedClientIdentity: clientIdentity,
    handshakePort: new OpenCodeBridgeCommandHandshakePort({ bridge, clientIdentity, timeoutMs: 1_000 }),
    leaseStore,
    ledger,
    bridge,
    manifestReader: { read: async () => ({ highWatermark: 0, activeRunId: null, capabilitySnapshotId: 'issue443-capability-v2' }) },
    requestIdFactory: sequentialIds('state-change'),
    diagnosticIdFactory: sequentialIds('state-diagnostic'),
    clock: () => new Date(NOW),
  });
  const readiness = new OpenCodeReadinessBridge(bridge, {
    timeoutMs: 1_000,
    launchTimeoutMs: 1_000,
    stateChangingCommands: stateChanging,
  });
  return { fake, ledger, adapter: new OpenCodeTeamRuntimeAdapter(readiness) };
}

async function createFake(scenario: string) {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'issue443-desktop-wire-'));
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
  return {
    sandbox,
    project,
    bridgeTemp,
    executable,
    traceFile,
    async traces(): Promise<FakeTrace[]> {
      const raw = await readFile(traceFile, 'utf8');
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
