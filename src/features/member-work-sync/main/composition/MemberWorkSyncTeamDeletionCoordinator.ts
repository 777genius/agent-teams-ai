import { access } from 'node:fs/promises';
import path from 'node:path';

import { normalizeMemberWorkSyncTeamOperationKey } from '../../core/application';

import type { TeamChangeEvent } from '@shared/types';

interface MemberWorkSyncTeamDeletionState {
  status: 'deleting' | 'deleted';
  preparation: Promise<void> | null;
  preparationSucceeded: boolean;
  pendingResumeTeamName: string | null;
  configAccess: Promise<void> | null;
  resumeReleased: boolean;
  quiescedTeamName: string | null;
  deletionIdentityId: string | null;
}

export interface MemberWorkSyncTeamDeletionCoordinatorPorts {
  teamsBasePath: string;
  configFileAccess?: (configPath: string) => Promise<void>;
  beginOperationGateQuiesce(teamName: string): void;
  awaitOperationGateIdle(teamName: string): Promise<void>;
  resumeOperationGate(teamName: string): void;
  cancelScheduledDispatch(teamName: string): void;
  beginAuditQuiesce(teamName: string): void;
  awaitAuditIdle(teamName: string): Promise<void>;
  resumeAudit(teamName: string): void;
  quiesceRouter(teamName: string): Promise<void>;
  resumeRouter(teamName: string): void;
  enqueueStartupScan(teamNames: string[]): Promise<void>;
  purgeTeam(teamName: string, deletionIdentityId?: string): Promise<void>;
}

/**
 * Preparation quiesces the team before it waits, and the wait has no deadline
 * of its own. A caller that bounds it has to be able to hand the quiesce back,
 * or the team stays parked with no result and no error. That is what aborting
 * through the signal does, and this is the failure both halves report.
 */
function abandonedPreparationError(teamName: string): Error {
  return new Error(
    `Member work sync deletion preparation for "${teamName}" was abandoned before it completed`
  );
}

export class MemberWorkSyncTeamDeletionCoordinator {
  private readonly states = new Map<string, MemberWorkSyncTeamDeletionState>();

  constructor(private readonly ports: MemberWorkSyncTeamDeletionCoordinatorPorts) {}

  prepare(
    teamName: string,
    deletionIdentityId?: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    if (options.signal?.aborted === true) {
      // An abort that arrives before the listener is attached would otherwise
      // be ignored, and the generation would quiesce the team with nothing left
      // to release it.
      return Promise.reject(abandonedPreparationError(teamName));
    }
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    const currentState = this.states.get(teamKey);
    if (currentState?.preparation) {
      return currentState.preparation;
    }

    const quiescedTeamName =
      currentState && !currentState.resumeReleased
        ? (currentState.quiescedTeamName ?? teamName)
        : teamName;
    const state: MemberWorkSyncTeamDeletionState = {
      status: 'deleting',
      preparation: null,
      preparationSucceeded: false,
      pendingResumeTeamName: currentState?.pendingResumeTeamName ?? null,
      configAccess: null,
      resumeReleased: false,
      quiescedTeamName,
      deletionIdentityId: deletionIdentityId?.trim() || null,
    };

    let resolvePreparation!: () => void;
    let rejectPreparation!: (error: unknown) => void;
    const preparation = new Promise<void>((resolve, reject) => {
      resolvePreparation = resolve;
      rejectPreparation = reject;
    });
    state.preparation = preparation;
    this.states.set(teamKey, state);

    let aborted = false;
    const abortPreparation = (): void => {
      if (aborted || state.preparation !== preparation) return;
      aborted = true;
      // Drop this generation before releasing anything: a null preparation
      // makes its late completion a no-op in finishPreparation, and removing
      // the state stops a retry from being handed a promise that may never
      // settle. resumeNow then gives back every quiescence source it took.
      state.preparation = null;
      this.resumeNow(teamName, teamKey, state, false);
      rejectPreparation(abandonedPreparationError(teamName));
    };
    options.signal?.addEventListener('abort', abortPreparation, { once: true });

    void this.prepareGeneration(
      teamName,
      quiescedTeamName,
      state.deletionIdentityId,
      () => aborted
    ).then(resolvePreparation, rejectPreparation);
    const finishPreparation = (succeeded: boolean): void => {
      if (state.preparation !== preparation) return;
      state.preparation = null;
      if (!succeeded) return;
      state.preparationSucceeded = true;
      const pendingResumeTeamName = state.pendingResumeTeamName;
      if (pendingResumeTeamName && this.states.get(teamKey) === state) {
        this.resumeNow(pendingResumeTeamName, teamKey, state, true);
      }
    };
    void preparation.then(
      () => finishPreparation(true),
      () => finishPreparation(false)
    );
    return preparation;
  }

  complete(teamName: string): void {
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    const state = this.states.get(teamKey);
    if (!state) {
      this.states.set(teamKey, {
        status: 'deleted',
        preparation: null,
        preparationSucceeded: true,
        pendingResumeTeamName: null,
        configAccess: null,
        resumeReleased: false,
        quiescedTeamName: null,
        deletionIdentityId: null,
      });
      return;
    }
    if (state.resumeReleased) return;
    if (!state.pendingResumeTeamName) {
      state.status = 'deleted';
    }
  }

  resume(teamName: string): void {
    this.requestResume(teamName, 'explicit');
  }

  interceptTeamChange(event: TeamChangeEvent): boolean {
    const teamName = event.teamName.trim();
    const teamKey = teamName ? normalizeMemberWorkSyncTeamOperationKey(teamName) : '';
    const state = this.states.get(teamKey);
    if (!state || state.resumeReleased) {
      return false;
    }
    if (
      state.status === 'deleted' &&
      event.type === 'config' &&
      event.detail === 'config.json' &&
      !state.configAccess
    ) {
      this.beginConfigResumeCheck(teamName, teamKey, state);
    }
    return true;
  }

  private async prepareGeneration(
    teamName: string,
    quiescedTeamName: string,
    deletionIdentityId: string | null,
    isAborted: () => boolean
  ): Promise<void> {
    this.ports.beginOperationGateQuiesce(quiescedTeamName);
    this.ports.cancelScheduledDispatch(quiescedTeamName);
    this.ports.beginAuditQuiesce(quiescedTeamName);
    const routerQuiesce = this.ports.quiesceRouter(quiescedTeamName);
    await this.ports.awaitOperationGateIdle(quiescedTeamName);
    await routerQuiesce;
    await this.ports.awaitAuditIdle(quiescedTeamName);
    // Everything above is the wait a caller can give up on. Once it has, the
    // team is running again, so this generation must not carry on into the
    // destructive half and purge the work-sync state out from under it.
    if (isAborted()) {
      throw abandonedPreparationError(teamName);
    }
    if (deletionIdentityId) {
      await this.ports.purgeTeam(teamName, deletionIdentityId);
    } else {
      await this.ports.purgeTeam(teamName);
    }
    await this.ports.awaitAuditIdle(quiescedTeamName);
  }

  private beginConfigResumeCheck(
    teamName: string,
    teamKey: string,
    state: MemberWorkSyncTeamDeletionState
  ): void {
    let configAccess: Promise<void>;
    try {
      configAccess = Promise.resolve(
        (this.ports.configFileAccess ?? access)(
          path.join(this.ports.teamsBasePath, teamName, 'config.json')
        )
      );
    } catch (error) {
      configAccess = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    state.configAccess = configAccess;
    void configAccess.then(
      () => {
        if (
          this.states.get(teamKey) === state &&
          state.status === 'deleted' &&
          state.configAccess === configAccess
        ) {
          state.configAccess = null;
          this.requestResume(teamName, 'automatic');
        }
      },
      () => {
        if (this.states.get(teamKey) === state && state.configAccess === configAccess) {
          state.configAccess = null;
        }
      }
    );
  }

  private requestResume(teamName: string, source: 'automatic' | 'explicit'): void {
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    const state = this.states.get(teamKey);
    if (state?.resumeReleased) {
      if (source === 'explicit') this.states.delete(teamKey);
      return;
    }
    if (state && !state.preparationSucceeded) {
      state.pendingResumeTeamName = teamName;
      return;
    }
    this.resumeNow(teamName, teamKey, state ?? null, source === 'automatic');
  }

  private resumeNow(
    teamName: string,
    teamKey: string,
    state: MemberWorkSyncTeamDeletionState | null,
    requiresExplicitAck: boolean
  ): void {
    const quiescedTeamName = state?.quiescedTeamName ?? teamName;
    if (state && this.states.get(teamKey) === state) {
      if (requiresExplicitAck) {
        state.pendingResumeTeamName = null;
        state.configAccess = null;
        state.resumeReleased = true;
      } else {
        this.states.delete(teamKey);
      }
    }
    this.ports.resumeOperationGate(quiescedTeamName);
    this.ports.resumeAudit(quiescedTeamName);
    this.ports.resumeRouter(quiescedTeamName);
    void this.ports.enqueueStartupScan([teamName.trim()]);
  }
}
