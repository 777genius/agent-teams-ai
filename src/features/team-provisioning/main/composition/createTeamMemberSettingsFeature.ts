import {
  ApplicationCommandFailureKind,
  type ApplicationCommandJsonValue,
  type ApplicationCommandRunner,
  ApplicationCommandRunOutcome,
} from '@features/application-command-ledger';

import { MemberSettingsPersistenceFailedError } from '../../core/application/ports/UpdateMemberSettingsPorts';
import { UpdateMemberSettingsUseCase } from '../../core/application/use-cases/UpdateMemberSettingsUseCase';
import {
  createMemberSettingsFingerprint,
  normalizeEditableMemberSettings,
} from '../../core/domain/memberSettingsPolicy';
import { LegacyMemberSettingsLifecycleAdapter } from './LegacyMemberSettingsLifecycle';
import { LegacyMemberSettingsMutationGateAdapter } from './LegacyMemberSettingsMutationGate';

import type {
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../contracts/memberSettings';
import type { MemberSettingsRepositoryPort } from '../../core/application/ports/UpdateMemberSettingsPorts';
import type { LegacyMemberSettingsLifecycleSource } from './LegacyMemberSettingsLifecycle';
import type { LegacyLiveRosterMutationSource } from './LegacyMemberSettingsMutationGate';

const COMMAND_NAMESPACE = 'team-member-settings';
const COMMAND_OPERATION = 'update_member_settings';
const MAX_IN_PROCESS_COMMANDS = 4_096;

export interface TeamMemberSettingsFeatureApi {
  updateMemberSettings(request: UpdateMemberSettingsRequest): Promise<UpdateMemberSettingsResult>;
}

export interface TeamMemberSettingsFeatureDependencies {
  mutationSource: LegacyLiveRosterMutationSource;
  lifecycleSource: LegacyMemberSettingsLifecycleSource;
  repository: MemberSettingsRepositoryPort;
  commandRunner?: ApplicationCommandRunner | null;
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

function recoveryRequiredResult(
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

/** Wires the focused ports and adds durable (or process-local) command idempotency. */
export function createTeamMemberSettingsFeature(
  dependencies: TeamMemberSettingsFeatureDependencies
): TeamMemberSettingsFeatureApi {
  const repository = dependencies.repository;

  const useCase = new UpdateMemberSettingsUseCase({
    mutationGate: new LegacyMemberSettingsMutationGateAdapter(dependencies.mutationSource),
    repository,
    lifecycle: new LegacyMemberSettingsLifecycleAdapter(dependencies.lifecycleSource),
  });
  const fallback = new InProcessMemberSettingsCommandRunner();

  return {
    async updateMemberSettings(request) {
      const execute = () => useCase.execute(request);
      if (!dependencies.commandRunner) {
        return fallback.run(request, execute);
      }

      const normalizedSettings = normalizeEditableMemberSettings(request.settings);
      const proposed = await repository.findTarget(request.teamName, request.memberName);
      const proposedFingerprint = proposed
        ? createMemberSettingsFingerprint({ ...proposed, settings: normalizedSettings })
        : null;
      const run = await dependencies.commandRunner.run<
        ApplicationCommandJsonValue,
        typeof COMMAND_OPERATION
      >(
        {
          namespace: COMMAND_NAMESPACE,
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
          reconcile: async () => {
            const current = await repository.findTarget(request.teamName, request.memberName);
            const currentFingerprint = current ? createMemberSettingsFingerprint(current) : null;
            if (current && proposedFingerprint && currentFingerprint === proposedFingerprint) {
              return {
                outcome: 'applied',
                result: jsonValue(
                  recoveryRequiredResult(
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
                recoveryRequiredResult(
                  request,
                  currentFingerprint,
                  'Target settings match neither the previous nor proposed fingerprint'
                )
              ),
            };
          },
        },
        async () => jsonValue(await execute())
      );
      return withReplay(
        run.result as UpdateMemberSettingsResult,
        run.outcome === ApplicationCommandRunOutcome.Replayed
      );
    },
  };
}
