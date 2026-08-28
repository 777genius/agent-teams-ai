import { initializeTeamHandlers, registerTeamHandlers, removeTeamHandlers } from '@main/ipc/teams';
import { bindTeamIpcHandlerApis } from '@main/services/team/contracts/TeamProvisioningApis';
import { type RuntimeBootstrapSpec } from '@main/services/team/provisioning/TeamProvisioningBootstrapSpec';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { invalidateAuthoritativeModelExecutionProofs } from '@main/services/team/TeamLaunchExecutionProofAuthority';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { spawnCli } from '@main/utils/childProcess';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { TEAM_LAUNCH, TEAM_PREPARE_PROVISIONING } from '@preload/constants/ipcChannels';
import { createRosterAuthorizationTransactionBridge } from '@preload/rosterAuthorizationTransactionBridge';
import {
  buildAuthoritativeModelChecks,
  materializeConcreteLaunchRoster,
} from '@renderer/components/team/dialogs/authoritativeLaunchIdentity';
import { commitAuthoritativePrepareCandidate } from '@renderer/components/team/dialogs/commitAuthoritativePrepareCandidate';
import { executeLaunchTeamDialogSubmissionWithRecheck } from '@renderer/components/team/dialogs/launchRosterAuthorizationTransaction';
import {
  buildProviderPrepareRequestSignature,
  buildProviderPrepareRuntimeStatusSignature,
} from '@renderer/components/team/dialogs/providerPrepareRequestSignature';
import {
  areProviderLaunchStatusesAuthoritative,
  resolveProvisioningPreparationAuthorizationState,
} from '@renderer/components/team/dialogs/provisioningLaunchAuthorization';
import { EventEmitter } from 'events';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

import type { ProvisioningLaunchAuthorizationInput } from '@renderer/components/team/dialogs/provisioningLaunchAuthorization';
import type {
  AuthoritativeModelExecutionProof,
  CliProviderStatus,
  IpcResult,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningPrepareResult,
} from '@shared/types';

const LEAD_PROVENANCE = {
  version: 1 as const,
  providerBackendId: 'default' as const,
  model: 'explicit' as const,
  effort: 'default' as const,
};

export type FakeProbeOutcome = 'ready' | 'timeout' | 'transient';
export type FakeDispatchEvidence = 'started' | 'unknown' | 'partial-then-retry';

export interface FakeDesktopAuthorityFidelityHarnessOptions {
  memberNames?: readonly string[];
}

interface FakeDeferredProbe {
  started: Promise<void>;
  resolve(): void;
}

function providerStatus(nowMs: number): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Fake Anthropic profile',
    supported: true,
    authenticated: true,
    authMethod: 'fake-profile-a',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    models: ['claude'],
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'anthropic',
      source: 'anthropic-models-api',
      status: 'ready',
      fetchedAt: new Date(nowMs).toISOString(),
      staleAt: new Date(nowMs + 45_000).toISOString(),
      defaultModelId: 'claude',
      defaultLaunchModel: 'claude',
      models: [
        {
          id: 'claude',
          launchModel: 'claude',
          displayName: 'Claude (fake catalog)',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'anthropic-models-api',
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
    modelAvailability: [
      { modelId: 'claude', status: 'available', checkedAt: new Date(nowMs).toISOString() },
    ],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'supported', ownership: 'provider-scoped' },
        mcp: { status: 'supported', ownership: 'provider-scoped' },
        skills: { status: 'supported', ownership: 'provider-scoped' },
        apiKeys: { status: 'supported', ownership: 'provider-scoped' },
      },
    },
  };
}

function materializedMember(name: string): TeamCreateRequest['members'][number] {
  return {
    name,
    runtimeSelectionProvenance: {
      version: 1,
      providerBackendId: 'inherited',
      model: 'inherited',
      effort: 'inherited',
    },
    providerId: 'anthropic',
    model: 'claude',
  };
}

export interface FakeDesktopAuthorityFidelityHarness {
  readonly sandbox: string;
  readonly project: string;
  readonly teamName: string;
  readonly transactionId: string;
  readonly service: TeamDataService;
  readonly provisioning: TeamProvisioningService;
  readonly members: TeamCreateRequest['members'];
  readonly effects: { sessions: number; processes: number; terminals: number };
  readonly memberEffects: {
    creates: Record<string, number>;
    cleanups: Record<string, number>;
  };
  readonly dispatchedSpecs: RuntimeBootstrapSpec[];
  readonly probes: Array<{ cwd: string | undefined; mode: unknown; checks: unknown }>;
  prepare(): Promise<ProvisioningLaunchAuthorizationInput>;
  authorization(): ProvisioningLaunchAuthorizationInput;
  launch(
    authorization?: ProvisioningLaunchAuthorizationInput,
    transactionId?: string
  ): Promise<boolean>;
  invokeRaw<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>;
  setProbeOutcome(outcome: FakeProbeOutcome): void;
  deferProbe(): FakeDeferredProbe;
  invalidateAuthority(): void;
  setDispatchEvidence(outcome: FakeDispatchEvidence): void;
  simulateRestart(): void;
  makeContinuationProofStale(): Promise<void>;
  makeContinuationOutcomeAmbiguous(kind: 'duplicate' | 'unknown'): Promise<void>;
  changeConfiguredMemberRole(memberName: string, role: string): Promise<void>;
  removeConfiguredMember(memberName: string): Promise<void>;
  addConfiguredMember(memberName: string): Promise<void>;
  makeStatusPassive(): void;
  makeCatalogStale(): void;
  changeAuthFingerprint(): void;
  changeConfigFingerprint(): void;
  assertNoRuntimeArtifacts(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createFakeDesktopAuthorityFidelityHarness(
  options: FakeDesktopAuthorityFidelityHarnessOptions = {}
): Promise<FakeDesktopAuthorityFidelityHarness> {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-authority-fidelity-'));
  const project = path.join(sandbox, 'project');
  const teamName = 'authority-fidelity-team';
  const transactionId = '55555555-5555-4555-8555-555555555555';
  await fs.mkdir(project);
  setClaudeBasePathOverride(sandbox);

  let status = providerStatus(Date.now());
  let probeOutcome: FakeProbeOutcome = 'ready';
  let deferredProbe: {
    promise: Promise<void>;
    resolve(): void;
    markStarted(): void;
    started: Promise<void>;
  } | null = null;
  let dispatchEvidence: FakeDispatchEvidence = 'started';
  let configFingerprint = 'config-a';
  let preparedAuthorization: ProvisioningLaunchAuthorizationInput | null = null;
  let lastPrepareResult: TeamProvisioningPrepareResult | null = null;
  const effects = { sessions: 0, processes: 0, terminals: 0 };
  const memberNames = [...(options.memberNames ?? ['alice'])];
  const memberEffects = {
    creates: {} as Record<string, number>,
    cleanups: {} as Record<string, number>,
  };
  const dispatchedSpecs: RuntimeBootstrapSpec[] = [];
  const probes: Array<{ cwd: string | undefined; mode: unknown; checks: unknown }> = [];
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: (_channel: string, _handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(_channel, _handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  };
  const service = new TeamDataService();
  const fakeMcpConfigPath = path.join(sandbox, 'fake-final-effect-mcp.json');
  const provisioning = new TeamProvisioningService(undefined, undefined, undefined, undefined, {
    writeConfigFile: async () => {
      await fs.writeFile(fakeMcpConfigPath, '{}');
      return fakeMcpConfigPath;
    },
    prepareConfig: async () => ({ version: 1, json: '{}' }),
    writePreparedConfigFile: async (prepared: { json: string }) => {
      await fs.writeFile(fakeMcpConfigPath, prepared.json);
      return fakeMcpConfigPath;
    },
    removeConfigFile: async () => {
      await fs.rm(fakeMcpConfigPath, { force: true });
    },
  } as never);
  const provisioningSeams = provisioning as unknown as {
    providerRuntime: {
      buildProvisioningEnv: (...args: unknown[]) => Promise<unknown>;
      probeClaudeRuntime: (...args: unknown[]) => Promise<unknown>;
      runProviderOneShotDiagnostic: (...args: unknown[]) => Promise<unknown>;
      validateAgentTeamsMcpRuntime: (...args: unknown[]) => Promise<void>;
    };
    readRuntimeProviderLaunchFacts: (...args: unknown[]) => Promise<unknown>;
    startFilesystemMonitor: (...args: unknown[]) => void;
  };
  vi.spyOn(provisioningSeams.providerRuntime, 'buildProvisioningEnv').mockImplementation(
    async () => ({
      env: { PATH: '/fake/final-effect' },
      authSource: 'none',
      providerArgs: [],
      geminiRuntimeAuth: null,
    })
  );
  vi.spyOn(provisioningSeams.providerRuntime, 'probeClaudeRuntime').mockImplementation(async () => {
    if (deferredProbe) {
      deferredProbe.markStarted();
      await deferredProbe.promise;
    }
    return probeOutcome === 'ready'
      ? {}
      : {
          warning:
            probeOutcome === 'timeout'
              ? 'Fake exact-model probe timed out'
              : 'Fake provider returned a transient status',
        };
  });
  vi.spyOn(provisioningSeams.providerRuntime, 'runProviderOneShotDiagnostic').mockImplementation(
    async (...args: unknown[]) => {
      const exactCheck = args[5] as TeamProvisioningModelCheckRequest | undefined;
      probes.push({ cwd: args[1] as string, mode: 'deep', checks: exactCheck ? [exactCheck] : [] });
      if (probeOutcome !== 'ready') {
        return {
          warning:
            probeOutcome === 'timeout'
              ? 'Fake exact-model probe timed out'
              : 'Fake provider returned a transient status',
        };
      }
      return { targetedLiveness: exactCheck };
    }
  );
  vi.spyOn(provisioningSeams, 'readRuntimeProviderLaunchFacts').mockResolvedValue({
    providerId: 'anthropic',
    modelIds: new Set(['claude']),
    defaultModel: 'claude',
    modelCatalog: null,
    runtimeCapabilities: { modelCatalog: { dynamic: false } },
  });
  vi.spyOn(provisioningSeams.providerRuntime, 'validateAgentTeamsMcpRuntime').mockResolvedValue(
    undefined
  );
  vi.spyOn(provisioningSeams, 'startFilesystemMonitor').mockImplementation(() => undefined);
  vi.mocked(spawnCli).mockImplementation((_command, args) => {
    effects.sessions += 1;
    effects.processes += 1;
    effects.terminals += 1;
    const specFlagIndex = args.indexOf('--team-bootstrap-spec');
    const specPath = specFlagIndex >= 0 ? args[specFlagIndex + 1] : undefined;
    if (!specPath) throw new Error('Production spawn omitted its bootstrap spec');
    const spec = JSON.parse(fsSync.readFileSync(specPath, 'utf8')) as RuntimeBootstrapSpec;
    if (!spec.runId) throw new Error('Production bootstrap spec omitted runId');
    if (!spec.launch?.rosterFingerprint) {
      throw new Error('Production launch bootstrap spec omitted its continuation roster binding');
    }
    dispatchedSpecs.push(spec);
    const continuation = spec.launch?.continuation;
    const dispatchMemberNames = spec.members.map((member) => member.name);
    const continuationRetryNames = continuation?.retryMembers.map((member) => member.name);
    if (
      continuationRetryNames &&
      (continuationRetryNames.length !== dispatchMemberNames.length ||
        continuationRetryNames.some((name, index) => name !== dispatchMemberNames[index]))
    ) {
      throw new Error('Production continuation evidence does not exactly bind dispatched members');
    }
    for (const name of dispatchMemberNames) {
      memberEffects.creates[name] = (memberEffects.creates[name] ?? 0) + 1;
    }
    const isPartialAttempt =
      dispatchEvidence === 'partial-then-retry' && !continuation && dispatchMemberNames.length > 1;
    const failedMemberName = isPartialAttempt ? dispatchMemberNames[1] : undefined;
    if (failedMemberName) {
      memberEffects.cleanups[failedMemberName] =
        (memberEffects.cleanups[failedMemberName] ?? 0) + 1;
      memberEffects.creates[failedMemberName] = 0;
    }
    if (dispatchEvidence !== 'unknown') {
      const updatedAt = new Date().toISOString();
      const evidenceId = `evidence:${spec.runId}`;
      const evidenceMembers = [
        ...(continuation?.preservedMembers.map((member) => ({
          name: member.name,
          outcome: 'bootstrap_confirmed' as const,
          runtimeRunId: member.runtimeRunId,
          observedAt: member.bootstrapConfirmedAt,
        })) ?? []),
        ...dispatchMemberNames.map((name) =>
          name === failedMemberName
            ? {
                name,
                outcome: 'failed' as const,
                observedAt: updatedAt,
                cleanup: { status: 'confirmed' as const, runId: spec.runId, observedAt: updatedAt },
              }
            : {
                name,
                outcome: 'bootstrap_confirmed' as const,
                runtimeRunId: spec.runId,
                observedAt: updatedAt,
              }
        ),
      ];
      fsSync.writeFileSync(
        path.join(sandbox, 'teams', teamName, 'bootstrap-state.json'),
        JSON.stringify({
          version: 1,
          runId: spec.runId,
          teamName,
          updatedAt,
          launchRosterFingerprint: spec.launch.rosterFingerprint,
          members: evidenceMembers.map((member) => ({
            name: member.name,
            status: member.outcome,
          })),
          launchContinuation: {
            version: 1,
            sourceRunId: spec.runId,
            teamName,
            evidenceId,
            updatedAt,
            rosterFingerprint: spec.launch.rosterFingerprint,
            members: evidenceMembers,
          },
          terminal: {
            status: isPartialAttempt ? 'partial_success' : 'completed',
            continuationEvidenceId: evidenceId,
          },
        })
      );
    }
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin: { writable: true, write: vi.fn(() => true), end: vi.fn() },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    const once = child.once.bind(child);
    child.once = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      once(event, listener);
      if (event === 'spawn') queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as typeof child.once;
    return child as never;
  });
  const members = materializeConcreteLaunchRoster({
    members: memberNames.map(materializedMember),
    leadProviderId: 'anthropic',
    leadBackendId: null,
    leadModel: 'claude',
    providerStatusById: new Map([['anthropic', status]]),
  });
  if (!members) throw new Error('Fake provider catalog did not materialize an exact roster');
  await service.createTeamConfig({
    teamName,
    cwd: project,
    providerId: 'anthropic',
    model: 'claude',
    leadRuntimeSelectionProvenance: LEAD_PROVENANCE,
    members,
  });
  await fs.writeFile(
    path.join(sandbox, 'teams', teamName, 'config.json'),
    JSON.stringify({
      leadAgentId: 'lead-1',
      projectPath: project,
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          agentId: 'lead-1',
        },
      ],
    })
  );

  const persistConfiguredMembers = async (): Promise<void> => {
    const metaPath = path.join(sandbox, 'teams', teamName, 'members.meta.json');
    const raw = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
      members?: Array<Record<string, unknown>>;
    };
    const existingByName = new Map(
      (raw.members ?? []).map((member) => [String(member.name), member] as const)
    );
    raw.members = members.map((member) => ({
      ...(existingByName.get(member.name) ?? {}),
      ...member,
      agentType: 'general-purpose',
      joinedAt: existingByName.get(member.name)?.joinedAt ?? Date.now(),
    }));
    await fs.writeFile(metaPath, JSON.stringify(raw));
  };

  initializeTeamHandlers(service, bindTeamIpcHandlerApis(provisioning));
  registerTeamHandlers(ipcMain as never);

  const invokeRaw = async <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing fake desktop IPC handler: ${channel}`);
    return (await handler({ sender: {} }, ...args)) as IpcResult<T>;
  };
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const result = await invokeRaw<T>(channel, ...args);
    if (!result.success) throw new Error(result.error);
    if (result.data === undefined) throw new Error(`Missing fake desktop IPC data: ${channel}`);
    return result.data;
  };
  const bridge = createRosterAuthorizationTransactionBridge(invoke);

  const statusMaps = () => ({
    statusById: new Map([['anthropic' as const, status]]),
    loadingById: new Map([['anthropic' as const, false]]),
  });
  const requestSignature = (): string => {
    const { statusById } = statusMaps();
    const runtimeStatusSignature = buildProviderPrepareRuntimeStatusSignature(
      ['anthropic'],
      statusById
    );
    return JSON.stringify({
      provider: buildProviderPrepareRequestSignature({
        cwd: project,
        selectedProviderId: 'anthropic',
        selectedModel: 'claude',
        selectedMemberProviders: ['anthropic'],
        runtimeStatusSignature,
      }),
      configFingerprint,
    });
  };
  const currentAuthorization = (): ProvisioningLaunchAuthorizationInput => {
    if (!preparedAuthorization) {
      return {
        prepareState: 'failed',
        providerStatusesAuthoritative: false,
        preparedRequestSignature: null,
        currentRequestSignature: requestSignature(),
        preparedGeneration: null,
        currentGeneration: 0,
        providerProofExpiresAtMs: null,
        executionProof: null,
      };
    }
    const { statusById, loadingById } = statusMaps();
    return {
      ...preparedAuthorization,
      currentRequestSignature: requestSignature(),
      providerStatusesAuthoritative: areProviderLaunchStatusesAuthoritative(
        ['anthropic'],
        statusById,
        loadingById,
        new Map([['anthropic', [{ model: 'claude', providerBackendId: null }]]])
      ),
      providerProofExpiresAtMs: status.modelCatalog
        ? Date.parse(status.modelCatalog.staleAt)
        : null,
    };
  };

  return {
    sandbox,
    project,
    teamName,
    transactionId,
    service,
    provisioning,
    members,
    effects,
    memberEffects,
    dispatchedSpecs,
    probes,
    async prepare() {
      const statusById = statusMaps().statusById;
      const checks = buildAuthoritativeModelChecks({
        leadProviderId: 'anthropic',
        leadModel: 'claude',
        leadBackendId: null,
        leadRuntimeSelectionProvenance: LEAD_PROVENANCE,
        providerStatusById: statusById,
        members,
        resolveMember: () => ({ providerId: 'anthropic', model: 'claude' }),
      });
      if (!checks.runtimeRosterRevision) throw new Error('Fake roster revision was not resolved');
      type Prepare = Parameters<
        typeof commitAuthoritativePrepareCandidate
      >[0]['prepareProvisioning'];
      const prepareProvisioning: Prepare = async (...args) => {
        const response = await invoke<TeamProvisioningPrepareResult>(
          TEAM_PREPARE_PROVISIONING,
          ...args
        );
        lastPrepareResult = response;
        return response;
      };
      let proof: AuthoritativeModelExecutionProof;
      try {
        proof = await commitAuthoritativePrepareCandidate({
          cwd: project,
          leadProviderId: 'anthropic',
          providerIds: ['anthropic'],
          checksByProvider: checks,
          runtimeRosterRevision: checks.runtimeRosterRevision,
          prepareProvisioning,
        });
      } catch (error) {
        preparedAuthorization = null;
        throw error;
      }
      const preparedSignature = requestSignature();
      const { statusById: preparedStatusById, loadingById: preparedLoadingById } = statusMaps();
      const prepareState = resolveProvisioningPreparationAuthorizationState(
        [
          {
            providerId: 'anthropic',
            status:
              lastPrepareResult?.ready && lastPrepareResult.executionProof ? 'ready' : 'failed',
            details: [lastPrepareResult?.message ?? 'No authoritative preparation payload'],
          },
        ],
        lastPrepareResult?.warnings ?? []
      );
      preparedAuthorization = {
        prepareState,
        providerStatusesAuthoritative: areProviderLaunchStatusesAuthoritative(
          ['anthropic'],
          preparedStatusById,
          preparedLoadingById,
          new Map([['anthropic', [{ model: 'claude', providerBackendId: null }]]])
        ),
        preparedRequestSignature: preparedSignature,
        currentRequestSignature: preparedSignature,
        preparedGeneration: proof.generation,
        currentGeneration: proof.generation,
        providerProofExpiresAtMs: status.modelCatalog
          ? Date.parse(status.modelCatalog.staleAt)
          : null,
        executionProof: proof,
      };
      preparedAuthorization = currentAuthorization();
      return preparedAuthorization;
    },
    authorization: currentAuthorization,
    launch(authorization = currentAuthorization(), launchTransactionId = transactionId) {
      return executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        launchTransactionId,
        () =>
          bridge.beginRosterAuthorizationTransaction(teamName, {
            transactionId: launchTransactionId,
            members,
          }),
        () => bridge.getRosterAuthorizationTransactionOutcome(teamName, launchTransactionId),
        async (proof) => {
          const response = await invoke<TeamCreateResponse>(TEAM_LAUNCH, {
            teamName,
            cwd: project,
            providerId: 'anthropic',
            model: 'claude',
            leadRuntimeSelectionProvenance: LEAD_PROVENANCE,
            rosterTransactionId: launchTransactionId,
            executionProof: proof,
          });
          if (response.launchStatus !== 'started' && response.launchStatus !== 'already_running') {
            throw new Error(`Unexpected production launch response: ${JSON.stringify(response)}`);
          }
        },
        () => bridge.rollbackRosterAuthorizationTransaction(teamName, launchTransactionId)
      );
    },
    invokeRaw,
    setProbeOutcome(outcome) {
      probeOutcome = outcome;
    },
    deferProbe() {
      let resolveProbe!: () => void;
      let markStarted!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveProbe = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      deferredProbe = { promise, resolve: resolveProbe, markStarted, started };
      return { started, resolve: resolveProbe };
    },
    invalidateAuthority() {
      invalidateAuthoritativeModelExecutionProofs();
    },
    setDispatchEvidence(outcome) {
      dispatchEvidence = outcome;
    },
    simulateRestart() {
      preparedAuthorization = null;
      lastPrepareResult = null;
      invalidateAuthoritativeModelExecutionProofs();
    },
    async makeContinuationProofStale() {
      const statePath = path.join(sandbox, 'teams', teamName, 'bootstrap-state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
      state.updatedAt = '2000-01-01T00:00:00.000Z';
      await fs.writeFile(statePath, JSON.stringify(state));
    },
    async makeContinuationOutcomeAmbiguous(kind) {
      const statePath = path.join(sandbox, 'teams', teamName, 'bootstrap-state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
      const continuation = state.launchContinuation as { members?: unknown[] };
      const first = continuation.members?.[0];
      continuation.members =
        kind === 'duplicate' && first
          ? [first, first]
          : continuation.members?.map((member, index) =>
              index === 0 && member && typeof member === 'object'
                ? { ...(member as Record<string, unknown>), outcome: 'unknown' }
                : member
            );
      await fs.writeFile(statePath, JSON.stringify(state));
    },
    async changeConfiguredMemberRole(memberName, role) {
      const member = members.find((candidate) => candidate.name === memberName);
      if (!member) throw new Error(`Unknown fake member: ${memberName}`);
      member.role = role;
      await persistConfiguredMembers();
    },
    async removeConfiguredMember(memberName) {
      const index = members.findIndex((candidate) => candidate.name === memberName);
      if (index < 0) throw new Error(`Unknown fake member: ${memberName}`);
      members.splice(index, 1);
      await persistConfiguredMembers();
    },
    async addConfiguredMember(memberName) {
      members.push(materializedMember(memberName));
      await persistConfiguredMembers();
    },
    makeStatusPassive() {
      status = { ...status, statusCheckOutcome: 'model_only' };
    },
    makeCatalogStale() {
      status = {
        ...status,
        modelCatalogRefreshState: 'ready',
        modelCatalog: status.modelCatalog
          ? {
              ...status.modelCatalog,
              status: 'stale',
              staleAt: new Date(Date.now() - 1).toISOString(),
            }
          : null,
      };
    },
    changeAuthFingerprint() {
      status = { ...status, authMethod: 'fake-profile-b' };
    },
    changeConfigFingerprint() {
      configFingerprint = 'config-b';
    },
    async assertNoRuntimeArtifacts() {
      if (effects.sessions || effects.processes || effects.terminals) {
        throw new Error(`Fake runtime was created early: ${JSON.stringify(effects)}`);
      }
      await fs
        .stat(path.join(sandbox, 'fake-runtime'))
        .then(() => {
          throw new Error('Fake runtime artifact directory exists before authorized dispatch');
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.message.includes('before authorized dispatch')) throw error;
          if (error.code !== 'ENOENT') throw error;
        });
    },
    async cleanup() {
      removeTeamHandlers(ipcMain as never);
      invalidateAuthoritativeModelExecutionProofs();
      setClaudeBasePathOverride(null);
      await fs.rm(sandbox, { recursive: true, force: true });
    },
  };
}
