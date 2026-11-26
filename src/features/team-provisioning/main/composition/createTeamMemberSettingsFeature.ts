import {
  ApplicationCommandFailureKind,
  type ApplicationCommandJsonValue,
  type ApplicationCommandReconciliation,
  type ApplicationCommandRunner,
  ApplicationCommandRunOutcome,
} from '@features/application-command-ledger';

import { MemberSettingsPersistenceFailedError } from '../../core/application/ports/UpdateMemberSettingsPorts';
import { UpdateMemberSettingsUseCase } from '../../core/application/use-cases/UpdateMemberSettingsUseCase';
import {
  createMemberSettingsFingerprint,
  normalizeEditableMemberSettings,
  toMemberSettingsTarget,
} from '../../core/domain/memberSettingsPolicy';
import {
  DefinitionLeadMemberSettingsRepositoryAdapter,
  definitionMemberSettingsLifecycle,
} from '../adapters/output/DefinitionLeadMemberSettingsAdapters';
import { LegacyMemberSettingsLifecycleAdapter } from '../adapters/output/LegacyMemberSettingsLifecycleAdapter';
import { LegacyMemberSettingsMutationGateAdapter } from '../adapters/output/LegacyMemberSettingsMutationGateAdapter';
import { LegacyMemberSettingsRepositoryAdapter } from '../adapters/output/LegacyMemberSettingsRepositoryAdapter';
import { createNodeLegacyMemberSettingsRepositoryDependencies } from '../adapters/output/LegacyMemberSettingsRepositoryAdapter';

import type {
  GetMemberSettingsTargetRequest,
  MemberSettingsTarget,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../contracts/memberSettings';
import type {
  MemberSettingsLifecyclePort,
  MemberSettingsRepositoryPort,
} from '../../core/application/ports/UpdateMemberSettingsPorts';
import type { DefinitionLaunchSettingsPort } from '../adapters/output/DefinitionLeadMemberSettingsAdapters';
import type { LegacyMemberSettingsLifecycleSource } from '../adapters/output/LegacyMemberSettingsLifecycleAdapter';
import type { LegacyLiveRosterMutationSource } from '../adapters/output/LegacyMemberSettingsMutationGateAdapter';
import type { LegacyMemberSettingsRepositoryDependencies } from '../adapters/output/LegacyMemberSettingsRepositoryAdapter';

interface NodeMemberSettingsRuntimeSource {
  isTeamAlive(teamName: string): boolean;
  assessLeadRuntimeRestart: NonNullable<
    LegacyMemberSettingsLifecycleSource['assessLeadRuntimeRestart']
  >;
  restartLeadRuntime: NonNullable<LegacyMemberSettingsLifecycleSource['restartLeadRuntime']>;
  persistLeadRuntimeSettings: NonNullable<
    LegacyMemberSettingsLifecycleSource['persistLeadRuntimeSettings']
  >;
}

interface NodeMemberSettingsCacheSource {
  invalidateTeamConfig(teamName: string): void;
  invalidateMemberRuntimeAdvisory(teamName: string): void;
}

const COMMAND_NAMESPACE = 'team-member-settings';
const COMMAND_OPERATION = 'update_member_settings';
const MAX_IN_PROCESS_COMMANDS = 4_096;

export interface TeamMemberSettingsFeatureApi {
  updateMemberSettings(request: UpdateMemberSettingsRequest): Promise<UpdateMemberSettingsResult>;
  getMemberSettingsTarget(
    request: GetMemberSettingsTargetRequest
  ): Promise<MemberSettingsTarget | null>;
}

export interface TeamMemberSettingsFeatureDependencies {
  mutationSource: LegacyLiveRosterMutationSource;
  /** The legacy runtime lifecycle; `lifecycle` replaces it for targets without a runtime. */
  lifecycleSource?: LegacyMemberSettingsLifecycleSource;
  lifecycle?: MemberSettingsLifecyclePort;
  repositoryDependencies?: LegacyMemberSettingsRepositoryDependencies;
  repository?: MemberSettingsRepositoryPort;
  commandRunner?: ApplicationCommandRunner | null;
  /**
   * When internal storage selected its JSON fallback for this session, the
   * durable ledger cannot start a command: the process-local idempotency is
   * used instead, like the other ledger consumers.
   */
  isDurableStorageAvailable?: () => Promise<boolean>;
}

export interface NodeTeamMemberSettingsFeatureDependencies {
  commandRunner?: ApplicationCommandRunner | null;
  isDurableStorageAvailable?: () => Promise<boolean>;
  memberLifecycle: LegacyLiveRosterMutationSource &
    Pick<LegacyMemberSettingsLifecycleSource, 'attachLiveRosterMember'>;
  runtime: NodeMemberSettingsRuntimeSource;
  getWorkerCache(): NodeMemberSettingsCacheSource;
}

interface InProcessCommandEntry {
  commandKey: string;
  idempotencyKey: string;
  payload: string;
  promise: Promise<UpdateMemberSettingsResult> | null;
  state: 'idle' | 'in_flight' | 'completed';
}

function withReplay(
  result: UpdateMemberSettingsResult,
  replayed: boolean
): UpdateMemberSettingsResult {
  return { ...result, replayed };
}

export function memberSettingsRecoveryRequiredResult(
  request: UpdateMemberSettingsRequest,
  currentFingerprint: string | null,
  cause: string
): UpdateMemberSettingsResult {
  return {
    outcome: 'completed',
    effect: 'recovery_required',
    memberName: request.memberName,
    previousFingerprint: request.expectedFingerprint,
    currentFingerprint: currentFingerprint ?? request.expectedFingerprint,
    replayed: false,
    recovery: { persistenceRestored: false, lifecycleRestored: false, cause },
  };
}

function normalizeScopePart(value: string): string {
  return value.trim().toLowerCase();
}

function commandScope(request: UpdateMemberSettingsRequest): string {
  return `${normalizeScopePart(request.teamName)}/${normalizeScopePart(request.memberName)}`;
}

function jsonValue(value: unknown): ApplicationCommandJsonValue {
  return JSON.parse(JSON.stringify(value)) as ApplicationCommandJsonValue;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class InProcessMemberSettingsCommandRunner {
  private readonly byCommandId = new Map<string, InProcessCommandEntry>();
  private readonly byIdempotencyKey = new Map<string, InProcessCommandEntry>();
  private readonly settledEntries = new Set<InProcessCommandEntry>();

  run(
    request: UpdateMemberSettingsRequest,
    execute: () => Promise<UpdateMemberSettingsResult>
  ): Promise<UpdateMemberSettingsResult> {
    const scope = commandScope(request);
    const commandKey = `${scope}\u0000${request.commandId}`;
    const idempotencyKey = `${scope}\u0000${request.idempotencyKey}`;
    const payload = JSON.stringify(jsonValue(request));
    const commandEntry = this.byCommandId.get(commandKey);
    const idempotencyEntry = this.byIdempotencyKey.get(idempotencyKey);
    if (commandEntry && idempotencyEntry && commandEntry !== idempotencyEntry) {
      return Promise.reject(new Error('Member settings command identities do not match'));
    }
    const existing = commandEntry ?? idempotencyEntry;
    if (existing) {
      if (
        existing.commandKey !== commandKey ||
        existing.idempotencyKey !== idempotencyKey ||
        existing.payload !== payload
      ) {
        return Promise.reject(new Error('Member settings command identity was reused'));
      }
      if (existing.promise) {
        return existing.promise.then((result) => withReplay(result, true));
      }
      return this.execute(existing, execute);
    }

    this.evictSettledEntriesForAdmission();
    if (this.byCommandId.size >= MAX_IN_PROCESS_COMMANDS) {
      return Promise.reject(new Error('In-process member settings command capacity was reached'));
    }
    const entry: InProcessCommandEntry = {
      commandKey,
      idempotencyKey,
      payload,
      promise: null,
      state: 'idle',
    };
    this.byCommandId.set(commandKey, entry);
    this.byIdempotencyKey.set(idempotencyKey, entry);
    return this.execute(entry, execute);
  }

  private execute(
    entry: InProcessCommandEntry,
    execute: () => Promise<UpdateMemberSettingsResult>
  ): Promise<UpdateMemberSettingsResult> {
    this.settledEntries.delete(entry);
    entry.state = 'in_flight';
    const promise = Promise.resolve().then(execute);
    entry.promise = promise;
    void promise.then(
      () => {
        if (entry.promise !== promise) return;
        entry.state = 'completed';
        this.settledEntries.add(entry);
      },
      () => {
        if (entry.promise !== promise) return;
        entry.promise = null;
        entry.state = 'idle';
        this.settledEntries.add(entry);
      }
    );
    return promise;
  }

  private evictSettledEntriesForAdmission(): void {
    while (this.byCommandId.size >= MAX_IN_PROCESS_COMMANDS) {
      const oldest = this.settledEntries.values().next().value;
      if (!oldest) return;
      this.settledEntries.delete(oldest);
      if (oldest.state === 'in_flight') continue;
      if (this.byCommandId.get(oldest.commandKey) === oldest) {
        this.byCommandId.delete(oldest.commandKey);
      }
      if (this.byIdempotencyKey.get(oldest.idempotencyKey) === oldest) {
        this.byIdempotencyKey.delete(oldest.idempotencyKey);
      }
    }
  }
}

/** Shared durable/process-local idempotency for a member settings command. */
export class MemberSettingsCommandExecutor {
  private readonly fallback = new InProcessMemberSettingsCommandRunner();

  constructor(
    private readonly namespace: string,
    private readonly runner?: ApplicationCommandRunner | null,
    private readonly isDurable?: () => Promise<boolean>
  ) {}

  async run(
    request: UpdateMemberSettingsRequest,
    execute: () => Promise<UpdateMemberSettingsResult>,
    prepareReconcile: () => Promise<
      () => Promise<ApplicationCommandReconciliation<ApplicationCommandJsonValue>>
    >
  ): Promise<UpdateMemberSettingsResult> {
    if (!this.runner || (this.isDurable && !(await this.isDurable()))) {
      return this.fallback.run(request, execute);
    }
    const reconcile = await prepareReconcile();
    const run = await this.runner.run<ApplicationCommandJsonValue, typeof COMMAND_OPERATION>(
      {
        namespace: this.namespace,
        scopeKey: commandScope(request),
        commandId: request.commandId,
        idempotencyKey: request.idempotencyKey,
        operation: COMMAND_OPERATION,
        payload: jsonValue(request),
        classifyError: (error) => ({
          failureKind:
            error instanceof MemberSettingsPersistenceFailedError
              ? error.recoveryRequired
                ? ApplicationCommandFailureKind.Terminal
                : ApplicationCommandFailureKind.Retryable
              : ApplicationCommandFailureKind.UnknownAfterTimeout,
          message: describeError(error),
        }),
        reconcile,
      },
      async () => jsonValue(await execute())
    );
    return withReplay(
      run.result as UpdateMemberSettingsResult,
      run.outcome === ApplicationCommandRunOutcome.Replayed
    );
  }
}

function requireLifecycle(
  dependencies: TeamMemberSettingsFeatureDependencies
): MemberSettingsLifecyclePort {
  if (dependencies.lifecycle) return dependencies.lifecycle;
  if (dependencies.lifecycleSource) {
    return new LegacyMemberSettingsLifecycleAdapter(dependencies.lifecycleSource);
  }
  throw new Error('Team member settings feature requires a lifecycle');
}

/** Wires the focused ports and adds durable (or process-local) command idempotency. */
export function createTeamMemberSettingsFeature(
  dependencies: TeamMemberSettingsFeatureDependencies
): TeamMemberSettingsFeatureApi {
  const repository =
    dependencies.repository ??
    (dependencies.repositoryDependencies
      ? new LegacyMemberSettingsRepositoryAdapter(dependencies.repositoryDependencies)
      : null);
  if (!repository) {
    throw new Error('Team member settings feature requires a repository');
  }

  const useCase = new UpdateMemberSettingsUseCase({
    mutationGate: new LegacyMemberSettingsMutationGateAdapter(dependencies.mutationSource),
    repository,
    lifecycle: requireLifecycle(dependencies),
  });
  const commands = new MemberSettingsCommandExecutor(
    COMMAND_NAMESPACE,
    dependencies.commandRunner,
    dependencies.isDurableStorageAvailable
  );

  return {
    async getMemberSettingsTarget(request) {
      const target = await repository.findTarget(request.teamName, request.memberName);
      return target ? toMemberSettingsTarget(target) : null;
    },
    async updateMemberSettings(request) {
      return commands.run(
        request,
        () => useCase.execute(request),
        async () => {
          const proposed = await repository.findTarget(request.teamName, request.memberName);
          const normalizedSettings = proposed
            ? normalizeEditableMemberSettings(
                request.targetKind === 'lead'
                  ? { ...proposed.settings, ...request.leadRuntime }
                  : request.settings
              )
            : null;
          const proposedFingerprint = proposed
            ? createMemberSettingsFingerprint({ ...proposed, settings: normalizedSettings! })
            : null;
          return async () => {
            const current = await repository.findTarget(request.teamName, request.memberName);
            const currentFingerprint = current ? createMemberSettingsFingerprint(current) : null;
            if (current && proposedFingerprint && currentFingerprint === proposedFingerprint) {
              return {
                outcome: 'applied',
                result: jsonValue(
                  memberSettingsRecoveryRequiredResult(
                    request,
                    currentFingerprint,
                    'Settings were persisted, but runtime lifecycle completion cannot be proven'
                  )
                ),
              };
            }
            if (currentFingerprint === request.expectedFingerprint) {
              return {
                outcome: 'not_applied',
                message: 'Target settings still match the pre-command fingerprint',
              };
            }
            return {
              outcome: 'applied',
              result: jsonValue(
                memberSettingsRecoveryRequiredResult(
                  request,
                  currentFingerprint,
                  'Target settings match neither the previous nor proposed fingerprint'
                )
              ),
            };
          };
        }
      );
    },
  };
}

/** Keeps legacy main-process wiring out of the application shell. */
export function createNodeTeamMemberSettingsFeature(
  dependencies: NodeTeamMemberSettingsFeatureDependencies
): TeamMemberSettingsFeatureApi {
  const isTeamAlive = (teamName: string) => dependencies.runtime.isTeamAlive(teamName);
  return createTeamMemberSettingsFeature({
    commandRunner: dependencies.commandRunner,
    isDurableStorageAvailable: dependencies.isDurableStorageAvailable,
    mutationSource: dependencies.memberLifecycle,
    lifecycleSource: {
      attachLiveRosterMember: (teamName, memberName, options) =>
        dependencies.memberLifecycle.attachLiveRosterMember(teamName, memberName, options),
      assessLeadRuntimeRestart: (input) => dependencies.runtime.assessLeadRuntimeRestart(input),
      restartLeadRuntime: async (input) => {
        await dependencies.runtime.restartLeadRuntime(input);
        try {
          const cache = dependencies.getWorkerCache();
          cache.invalidateTeamConfig(input.teamName);
          cache.invalidateMemberRuntimeAdvisory(input.teamName);
        } catch {
          // Metadata is committed; the filesystem watcher remains the fallback refresh path.
        }
      },
      persistLeadRuntimeSettings: (input) => dependencies.runtime.persistLeadRuntimeSettings(input),
      isTeamAlive,
    },
    repositoryDependencies: nodeRepositoryDependencies(isTeamAlive, dependencies.getWorkerCache),
  });
}

function nodeRepositoryDependencies(
  isTeamAlive: (teamName: string) => boolean,
  getWorkerCache: () => NodeMemberSettingsCacheSource
): LegacyMemberSettingsRepositoryDependencies {
  return createNodeLegacyMemberSettingsRepositoryDependencies({
    isTeamAlive,
    invalidateWorkerCache: (teamName) => {
      const cache = getWorkerCache();
      cache.invalidateTeamConfig(teamName);
      cache.invalidateMemberRuntimeAdvisory(teamName);
    },
  });
}

export interface NodeDefinitionLeadSettingsFeatureDependencies {
  commandRunner?: ApplicationCommandRunner | null;
  isDurableStorageAvailable?: () => Promise<boolean>;
  memberLifecycle: LegacyLiveRosterMutationSource;
  launchSettings: DefinitionLaunchSettingsPort;
  isTeamAlive(teamName: string): boolean;
  getWorkerCache(): NodeMemberSettingsCacheSource;
}

/**
 * The lead of a team definition (a team with separate history per project):
 * the same use case, roster lock and command ledger as every member settings
 * change, with the definition's launch settings as the lead's settings and no
 * runtime to restart. The caller decides that a target is a definition lead and
 * holds the definition write around it.
 */
export function createNodeDefinitionLeadSettingsFeature(
  dependencies: NodeDefinitionLeadSettingsFeatureDependencies
): TeamMemberSettingsFeatureApi {
  const isTeamAlive = (teamName: string) => dependencies.isTeamAlive(teamName);
  return createTeamMemberSettingsFeature({
    commandRunner: dependencies.commandRunner,
    isDurableStorageAvailable: dependencies.isDurableStorageAvailable,
    mutationSource: dependencies.memberLifecycle,
    lifecycle: definitionMemberSettingsLifecycle,
    repository: new DefinitionLeadMemberSettingsRepositoryAdapter(
      new LegacyMemberSettingsRepositoryAdapter(
        nodeRepositoryDependencies(isTeamAlive, dependencies.getWorkerCache)
      ),
      dependencies.launchSettings
    ),
  });
}
