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
  /**
   * The purge this generation must not hand the team back across: its own once
   * it has started one, the generation before it until then. Null while no
   * purge on this team is outstanding.
   */
  destructivePhase: Promise<void> | null;
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

/**
 * How long an abandoned preparation may keep holding the team while the purge
 * it already started finishes. The purge deletes the team's work-sync state and
 * cannot be cancelled, so handing the team back on top of a running one lets
 * work be recreated into a tree that is still being deleted; its settlement is
 * the correct release point. The bound exists because an unbounded hold is the
 * defect this whole path was written for - a purge that never settles must not
 * park the team for the rest of the session. When the grace expires the team is
 * released anyway and the purge is left to finish on its own.
 */
const ABANDONED_PURGE_RELEASE_GRACE_MS = 30_000;

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
    const precedingDestructivePhase = currentState?.destructivePhase ?? null;
    const state: MemberWorkSyncTeamDeletionState = {
      status: 'deleting',
      preparation: null,
      preparationSucceeded: false,
      pendingResumeTeamName: currentState?.pendingResumeTeamName ?? null,
      configAccess: null,
      resumeReleased: false,
      quiescedTeamName,
      deletionIdentityId: deletionIdentityId?.trim() || null,
      destructivePhase: precedingDestructivePhase,
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
      // Drop this generation before anything else: a null preparation makes its
      // late completion a no-op in finishPreparation, and stops a retry from
      // being handed a promise that may never settle. The caller is told right
      // away; giving the quiescence back is the part that has to wait until
      // this generation can no longer act on the team.
      state.preparation = null;
      rejectPreparation(abandonedPreparationError(teamName));
      this.releaseAbandonedGeneration(teamName, teamKey, state);
    };
    options.signal?.addEventListener('abort', abortPreparation, { once: true });

    void this.prepareGeneration(
      teamName,
      quiescedTeamName,
      state,
      precedingDestructivePhase,
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
        destructivePhase: null,
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
    state: MemberWorkSyncTeamDeletionState,
    precedingDestructivePhase: Promise<void> | null,
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
    // An abandoned generation's purge cannot be cancelled, so a retry queues
    // behind it instead of deleting the same state twice at once.
    if (precedingDestructivePhase) {
      await precedingDestructivePhase;
      if (isAborted()) {
        throw abandonedPreparationError(teamName);
      }
    }
    const purge = state.deletionIdentityId
      ? this.ports.purgeTeam(teamName, state.deletionIdentityId)
      : this.ports.purgeTeam(teamName);
    // Recorded with no await in between, so an abort either sees no purge of
    // its own at all or sees exactly the one it has to wait for.
    state.destructivePhase = purge.then(
      () => undefined,
      () => undefined
    );
    await purge;
    await this.ports.awaitAuditIdle(quiescedTeamName);
  }

  /**
   * Hand back what an abandoned generation quiesced, once it can no longer act
   * on the team. Before a purge there is nothing uncancellable left to wait for
   * - a late router quiesce is a no-op once the router has been resumed - so
   * the release is immediate, which is what the caller's retry needs. Inside a
   * purge it waits for that purge, or for the grace above, whichever is first.
   */
  private releaseAbandonedGeneration(
    teamName: string,
    teamKey: string,
    state: MemberWorkSyncTeamDeletionState
  ): void {
    const destructivePhase = state.destructivePhase;
    if (!destructivePhase) {
      this.resumeNow(teamName, teamKey, state, false);
      return;
    }
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (graceTimer) clearTimeout(graceTimer);
      // A newer generation quiesced the team again while this one was settling.
      // Releasing here would unquiesce that deletion; it owns the release now,
      // and it inherited this purge as its own preceding destructive phase.
      if (this.states.get(teamKey) !== state) return;
      this.resumeNow(teamName, teamKey, state, false);
    };
    graceTimer = setTimeout(release, ABANDONED_PURGE_RELEASE_GRACE_MS);
    graceTimer.unref?.();
    void destructivePhase.then(release, release);
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
