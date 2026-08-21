import {
  createMemberSettingsFingerprint,
  isCanonicalLeadTarget,
  normalizeEditableMemberSettings,
  selectMemberSettingsLifecycleAction,
} from '../../domain/memberSettingsPolicy';
import {
  MemberSettingsLifecycleFailedError,
  MemberSettingsMutationBusyError,
  MemberSettingsPersistenceFailedError,
} from '../ports/UpdateMemberSettingsPorts';

import type {
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../../contracts/memberSettings';
import type {
  MemberSettingsLifecyclePort,
  MemberSettingsMutationGatePort,
  MemberSettingsRepositoryPort,
} from '../ports/UpdateMemberSettingsPorts';

export interface UpdateMemberSettingsUseCaseDependencies {
  mutationGate: MemberSettingsMutationGatePort;
  repository: MemberSettingsRepositoryPort;
  lifecycle: MemberSettingsLifecyclePort;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UpdateMemberSettingsUseCase {
  constructor(private readonly dependencies: UpdateMemberSettingsUseCaseDependencies) {}

  async execute(request: UpdateMemberSettingsRequest): Promise<UpdateMemberSettingsResult> {
    try {
      return await this.dependencies.mutationGate.runExclusive(request.teamName, async () => {
        const current = await this.dependencies.repository.findTarget(
          request.teamName,
          request.memberName
        );
        const actualFingerprint = current ? createMemberSettingsFingerprint(current) : null;
        if (!current || actualFingerprint !== request.expectedFingerprint) {
          return {
            outcome: 'target_conflict',
            memberName: current?.name ?? request.memberName,
            expectedFingerprint: request.expectedFingerprint,
            actualFingerprint,
            reason: current
              ? 'target_changed'
              : await this.dependencies.repository.classifyMissingTarget(request.teamName),
            replayed: false,
          };
        }

        const targetIsLead = isCanonicalLeadTarget(current);
        if (targetIsLead !== (request.targetKind === 'lead')) {
          return {
            outcome: 'target_conflict',
            memberName: current.name,
            expectedFingerprint: request.expectedFingerprint,
            actualFingerprint,
            reason: 'target_changed',
            replayed: false,
          };
        }
        const normalizedSettings = normalizeEditableMemberSettings(
          request.targetKind === 'lead'
            ? { ...current.settings, ...request.leadRuntime }
            : request.settings
        );
        const proposed = { ...current, settings: normalizedSettings };
        const proposedFingerprint = createMemberSettingsFingerprint(proposed);
        if (proposedFingerprint === actualFingerprint) {
          return {
            outcome: 'completed',
            effect: 'no_changes',
            memberName: current.name,
            previousFingerprint: actualFingerprint,
            currentFingerprint: actualFingerprint,
            replayed: false,
          };
        }

        const action = selectMemberSettingsLifecycleAction(current, proposed);
        if (action === 'require_team_relaunch') {
          return {
            outcome: 'completed',
            effect: 'team_relaunch_required',
            memberName: current.name,
            previousFingerprint: actualFingerprint,
            currentFingerprint: actualFingerprint,
            replayed: false,
          };
        }

        let admission: Awaited<ReturnType<MemberSettingsLifecyclePort['assess']>> | null = null;
        if (action !== 'none') {
          admission = await this.dependencies.lifecycle.assess({
            teamName: request.teamName,
            before: current,
            proposed,
            action,
          });
          if (admission.outcome === 'busy') {
            return {
              outcome: 'busy',
              teamName: request.teamName,
              memberName: current.name,
              replayed: false,
            };
          }
          if (admission.outcome === 'relaunch_required') {
            return {
              outcome: 'completed',
              effect: 'team_relaunch_required',
              memberName: current.name,
              previousFingerprint: actualFingerprint,
              currentFingerprint: actualFingerprint,
              replayed: false,
            };
          }
        }

        let applied;
        try {
          applied = await this.dependencies.repository.applyTarget({
            teamName: request.teamName,
            memberName: request.memberName,
            expectedFingerprint: actualFingerprint,
            settings: normalizedSettings,
          });
        } catch (error) {
          if (error instanceof MemberSettingsPersistenceFailedError && error.recoveryRequired) {
            const latest = await this.dependencies.repository.findTarget(
              request.teamName,
              request.memberName
            );
            return {
              outcome: 'completed',
              effect: 'recovery_required',
              memberName: latest?.name ?? current.name,
              previousFingerprint: actualFingerprint,
              currentFingerprint: latest
                ? createMemberSettingsFingerprint(latest)
                : actualFingerprint,
              replayed: false,
              recovery: {
                persistenceRestored: false,
                lifecycleRestored: true,
                cause: error.message,
              },
            };
          }
          throw error;
        }
        if (applied.outcome === 'target_conflict') {
          return {
            outcome: 'target_conflict',
            memberName: applied.current?.name ?? request.memberName,
            expectedFingerprint: actualFingerprint,
            actualFingerprint: applied.current
              ? createMemberSettingsFingerprint(applied.current)
              : null,
            reason: applied.current
              ? 'target_changed'
              : await this.dependencies.repository.classifyMissingTarget(request.teamName),
            replayed: false,
          };
        }

        const after = applied.snapshot;
        const afterFingerprint = createMemberSettingsFingerprint(after);
        if (action === 'none') {
          return {
            outcome: 'completed',
            effect: 'persisted_only',
            memberName: after.name,
            previousFingerprint: actualFingerprint,
            currentFingerprint: afterFingerprint,
            replayed: false,
          };
        }
        if (admission?.outcome !== 'ready') {
          throw new Error('Member settings lifecycle admission was not retained');
        }

        try {
          const effect = await this.dependencies.lifecycle.applyEffect({
            teamName: request.teamName,
            before: current,
            after,
            action,
            admission,
          });
          return {
            outcome: 'completed',
            effect,
            memberName: after.name,
            previousFingerprint: actualFingerprint,
            currentFingerprint: afterFingerprint,
            replayed: false,
          };
        } catch (error) {
          let persistenceRestored = false;
          let lifecycleRestored =
            error instanceof MemberSettingsLifecycleFailedError && error.lifecycleRestored;
          try {
            persistenceRestored = await this.dependencies.repository.restoreTarget({
              teamName: request.teamName,
              memberName: after.name,
              expectedFingerprint: afterFingerprint,
              snapshot: current,
              rollbackToken: applied.rollbackToken,
            });
          } catch {
            persistenceRestored = false;
          }
          if (persistenceRestored && !lifecycleRestored) {
            try {
              lifecycleRestored = await this.dependencies.lifecycle.restore({
                teamName: request.teamName,
                before: current,
                after,
                attemptedAction: action,
              });
            } catch {
              lifecycleRestored = false;
            }
          }

          if (persistenceRestored && lifecycleRestored && action === 'restart_lead') {
            return {
              outcome: 'completed',
              effect: 'lead_restart_rolled_back',
              memberName: current.name,
              previousFingerprint: actualFingerprint,
              currentFingerprint: actualFingerprint,
              replayed: false,
              recovery: {
                persistenceRestored: true,
                lifecycleRestored: true,
                cause: errorMessage(error),
              },
            };
          }
          if (persistenceRestored && lifecycleRestored) {
            throw error;
          }
          return {
            outcome: 'completed',
            effect: 'recovery_required',
            memberName: after.name,
            previousFingerprint: actualFingerprint,
            currentFingerprint: persistenceRestored ? actualFingerprint : afterFingerprint,
            replayed: false,
            recovery: {
              persistenceRestored,
              lifecycleRestored,
              cause: errorMessage(error),
            },
          };
        }
      });
    } catch (error) {
      if (error instanceof MemberSettingsMutationBusyError) {
        return {
          outcome: 'busy',
          teamName: request.teamName,
          memberName: request.memberName,
          replayed: false,
        };
      }
      throw error;
    }
  }
}
