import type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './HostedApprovalRuntimeAdmissionPublisher';
import type { HostedApprovalRuntimeOwnerLeaseContract } from './HostedApprovalRuntimeProductionLifecycleBoundary';

const LIFECYCLE_ATTEMPT = /^approval-lifecycle-attempt_[0-9a-f]{32}$/u;
const TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

type ProvisioningLifecycle = Extract<
  HostedApprovalRuntimeLifecycle,
  { readonly state: 'provisioning' }
>;
type RestartRequiredPublication = Extract<
  HostedApprovalRuntimePublication,
  { readonly state: 'restart_required' }
>;
type ActivePublication = Extract<HostedApprovalRuntimePublication, { readonly state: 'active' }>;

/** Product-owned lifecycle truth. This port must read launcher state, never admission bytes. */
export interface HostedApprovalRuntimeLifecycleProjectionPort {
  readProvisioningLifecycle(teamName: string): Promise<ProvisioningLifecycle | null>;
  readSuccessorOwnerGeneration(
    teamName: string,
    predecessorOwnerGeneration: number
  ): Promise<number | null>;
}

/** Publication remains evidence-bearing; this port cannot manufacture an owner lease. */
export interface HostedApprovalRuntimeLifecyclePublisherPort {
  publish(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle,
    ownerLease: HostedApprovalRuntimeOwnerLeaseContract | null
  ): Promise<HostedApprovalRuntimePublication>;
  ensureAbsent(teamName: string, reason: string): Promise<HostedApprovalRuntimePublication>;
}

export interface HostedApprovalRuntimeSuccessorRestart {
  readonly predecessorOwnerGeneration: number;
  readonly approvalGeneration: number;
  readonly approvalDigest: `sha256:${string}`;
  readonly admissionDocumentDigest: `sha256:${string}`;
}

/** The restart port performs only the launcher restart; it cannot sign or publish admission. */
export interface HostedApprovalRuntimeRestartPort {
  restartSuccessor(
    teamName: string,
    transition: HostedApprovalRuntimeSuccessorRestart
  ): Promise<void>;
}

export interface HostedApprovalRuntimeLifecycleCoordinatorDependencies {
  readonly projection: HostedApprovalRuntimeLifecycleProjectionPort;
  readonly ownerLease: HostedApprovalRuntimeOwnerLeaseContract | null;
  readonly publisher: HostedApprovalRuntimeLifecyclePublisherPort;
  readonly restart: HostedApprovalRuntimeRestartPort;
}

/**
 * Product-owned two-generation coordinator. A per-team queue is the local ordering pin; each
 * evidence-bearing publication independently consumes the remote owner lease/pin in the publisher.
 */
export class HostedApprovalRuntimeLifecycleCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly attempts = new Map<string, Promise<HostedApprovalRuntimePublication>>();
  private readonly ownerEpochs = new Map<string, number>();
  private readonly closedTeamAdmissions = new Set<string>();
  private readonly postShutdownAdmissions = new Set<string>();
  private shutdownAdmissionClosed = false;

  constructor(
    private readonly dependencies: HostedApprovalRuntimeLifecycleCoordinatorDependencies
  ) {}

  transitionToActive(
    teamName: string,
    lifecycleAttemptId: string
  ): Promise<HostedApprovalRuntimePublication> {
    if (!TEAM_NAME.test(teamName) || !LIFECYCLE_ATTEMPT.test(lifecycleAttemptId)) {
      return Promise.resolve(unavailable('hosted-approval-runtime-lifecycle-attempt-invalid'));
    }
    const closedReason = this.closedAdmissionReason(teamName);
    if (closedReason) return this.rejectClosedTransition(teamName, closedReason);

    const attemptKey = `${teamName}\0${lifecycleAttemptId}`;
    const retained = this.attempts.get(attemptKey);
    if (retained) return retained;

    const ownerEpoch = this.currentOwnerEpoch(teamName);
    const transition = this.serialized(teamName, () => this.runTransition(teamName, ownerEpoch));
    this.attempts.set(attemptKey, transition);
    return transition;
  }

  /** Synchronously fences in-flight work, then proves absence before the owner-loss effect. */
  beforeOwnerLoss<T>(teamName: string, effect: () => Promise<T>): Promise<T> {
    if (!TEAM_NAME.test(teamName)) {
      return Promise.reject(new TypeError('hosted-approval-runtime-team-invalid'));
    }
    this.closedTeamAdmissions.add(teamName);
    this.postShutdownAdmissions.delete(teamName);
    this.advanceOwnerEpoch(teamName);
    this.discardAttempts(teamName);
    return this.serialized(teamName, async () => {
      await this.requireAbsence(teamName, 'hosted-approval-runtime-owner-lost');
      return effect();
    });
  }

  /** Reopens only this team after the caller has admitted a distinct fresh owner. */
  admitFreshOwner(teamName: string): void {
    if (!TEAM_NAME.test(teamName)) {
      throw new TypeError('hosted-approval-runtime-team-invalid');
    }
    this.advanceOwnerEpoch(teamName);
    this.discardAttempts(teamName);
    this.closedTeamAdmissions.delete(teamName);
    if (this.shutdownAdmissionClosed) this.postShutdownAdmissions.add(teamName);
  }

  /** Product restart recovery never adopts an old lease or admission document. */
  async recoverAfterProductRestart(teamNames: readonly string[]): Promise<void> {
    await this.fenceAndRevokeTeams(teamNames, 'hosted-approval-runtime-product-restarted');
  }

  /** Synchronously fences every team, then proves absence before the shutdown effect. */
  beforeShutdown<T>(teamNames: readonly string[], effect: () => Promise<T>): Promise<T> {
    const normalizedTeamNames = normalizeTeamNames([...teamNames, ...this.queues.keys()]);

    // This global gate is closed in the caller's stack, before revocation can yield. A later
    // transition remains closed unless its owner is explicitly readmitted as fresh.
    this.shutdownAdmissionClosed = true;
    this.postShutdownAdmissions.clear();
    for (const teamName of normalizedTeamNames) {
      this.advanceOwnerEpoch(teamName);
      this.discardAttempts(teamName);
    }

    return this.revokeTeamsThenEffect(
      normalizedTeamNames,
      'hosted-approval-runtime-shutdown',
      effect
    );
  }

  private async fenceAndRevokeTeams(teamNames: readonly string[], reason: string): Promise<void> {
    const normalizedTeamNames = normalizeTeamNames(teamNames);
    for (const teamName of normalizedTeamNames) {
      this.advanceOwnerEpoch(teamName);
      this.discardAttempts(teamName);
    }
    for (const teamName of normalizedTeamNames) {
      await this.serialized(teamName, () => this.requireAbsence(teamName, reason));
    }
  }

  private async revokeTeamsThenEffect<T>(
    teamNames: readonly string[],
    reason: string,
    effect: () => Promise<T>
  ): Promise<T> {
    for (const teamName of teamNames) {
      await this.serialized(teamName, () => this.requireAbsence(teamName, reason));
    }
    return effect();
  }

  private rejectClosedTransition(
    teamName: string,
    reason: string
  ): Promise<HostedApprovalRuntimePublication> {
    return this.serialized(teamName, async () => {
      await this.requireAbsence(teamName, reason);
      return unavailable(reason);
    });
  }

  private closedAdmissionReason(teamName: string): string | null {
    if (this.closedTeamAdmissions.has(teamName)) {
      return 'hosted-approval-runtime-owner-lost';
    }
    if (this.shutdownAdmissionClosed && !this.postShutdownAdmissions.has(teamName)) {
      return 'hosted-approval-runtime-shutdown';
    }
    return null;
  }

  private async runTransition(
    teamName: string,
    ownerEpoch: number
  ): Promise<HostedApprovalRuntimePublication> {
    try {
      // No prior product lease survives a process or logical lifecycle attempt.
      await this.requireAbsence(teamName, 'hosted-approval-runtime-lifecycle-transition-start');
      this.assertOwnerCurrent(teamName, ownerEpoch);
      if (!this.dependencies.ownerLease) {
        throw new Error('hosted-approval-runtime-owner-lease-unavailable');
      }

      const provisioning = await this.dependencies.projection.readProvisioningLifecycle(teamName);
      if (!provisioning || !isPositiveSafeInteger(provisioning.ownerGeneration)) {
        throw new Error('hosted-approval-runtime-provisioning-projection-unavailable');
      }
      this.assertOwnerCurrent(teamName, ownerEpoch);

      const reserved = await this.publish(teamName, provisioning);
      if (reserved.state !== 'restart_required') {
        throw new Error('hosted-approval-runtime-restart-evidence-unavailable');
      }
      this.assertOwnerCurrent(teamName, ownerEpoch);

      const restartRequired: HostedApprovalRuntimeLifecycle = Object.freeze({
        state: 'restart_required',
        ownerGeneration: provisioning.ownerGeneration,
        approvalGeneration: reserved.approvalGeneration,
      });
      const confirmed = await this.publish(teamName, restartRequired);
      if (!sameRestartEvidence(reserved, confirmed)) {
        throw new Error('hosted-approval-runtime-restart-evidence-rotated');
      }
      this.assertOwnerCurrent(teamName, ownerEpoch);

      await this.dependencies.restart.restartSuccessor(
        teamName,
        Object.freeze({
          predecessorOwnerGeneration: provisioning.ownerGeneration,
          approvalGeneration: reserved.approvalGeneration,
          approvalDigest: reserved.approvalDigest,
          admissionDocumentDigest: reserved.admissionDocumentDigest,
        })
      );
      this.assertOwnerCurrent(teamName, ownerEpoch);

      const successorOwnerGeneration =
        await this.dependencies.projection.readSuccessorOwnerGeneration(
          teamName,
          provisioning.ownerGeneration
        );
      if (
        !isPositiveSafeInteger(successorOwnerGeneration) ||
        successorOwnerGeneration <= provisioning.ownerGeneration
      ) {
        throw new Error('hosted-approval-runtime-successor-not-current');
      }
      this.assertOwnerCurrent(teamName, ownerEpoch);

      // Approval evidence is copied only from the pinned publisher result, never from the restart.
      const activeLifecycle: HostedApprovalRuntimeLifecycle = Object.freeze({
        state: 'active',
        ownerGeneration: successorOwnerGeneration,
        approvalGeneration: reserved.approvalGeneration,
        approvalDigest: reserved.approvalDigest,
      });
      const active = await this.publish(teamName, activeLifecycle);
      if (!sameActiveEvidence(reserved, successorOwnerGeneration, active)) {
        throw new Error('hosted-approval-runtime-successor-evidence-mismatch');
      }
      this.assertOwnerCurrent(teamName, ownerEpoch);
      return active;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'hosted-approval-runtime-transition-failed';
      await this.requireAbsence(teamName, reason);
      return unavailable(reason);
    }
  }

  private publish(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimePublication> {
    return this.dependencies.publisher.publish(teamName, lifecycle, this.dependencies.ownerLease);
  }

  private async requireAbsence(teamName: string, reason: string): Promise<void> {
    const publication = await this.dependencies.publisher.ensureAbsent(teamName, reason);
    if (publication.state !== 'absent' && publication.state !== 'revoked') {
      throw new Error('hosted-approval-runtime-revocation-unconfirmed');
    }
  }

  private assertOwnerCurrent(teamName: string, ownerEpoch: number): void {
    if (this.currentOwnerEpoch(teamName) !== ownerEpoch) {
      throw new Error('hosted-approval-runtime-owner-lost');
    }
  }

  private currentOwnerEpoch(teamName: string): number {
    return this.ownerEpochs.get(teamName) ?? 0;
  }

  private advanceOwnerEpoch(teamName: string): void {
    this.ownerEpochs.set(teamName, this.currentOwnerEpoch(teamName) + 1);
  }

  private discardAttempts(teamName: string): void {
    const prefix = `${teamName}\0`;
    for (const attemptKey of this.attempts.keys()) {
      if (attemptKey.startsWith(prefix)) this.attempts.delete(attemptKey);
    }
  }

  private serialized<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(teamName) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.queues.set(teamName, next);
    const cleanup = (): void => {
      if (this.queues.get(teamName) === next) this.queues.delete(teamName);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}

function sameRestartEvidence(
  reserved: RestartRequiredPublication,
  publication: HostedApprovalRuntimePublication
): publication is RestartRequiredPublication {
  return (
    publication.state === 'restart_required' &&
    publication.approvalGeneration === reserved.approvalGeneration &&
    publication.approvalDigest === reserved.approvalDigest &&
    publication.admissionDocumentDigest === reserved.admissionDocumentDigest
  );
}

function sameActiveEvidence(
  reserved: RestartRequiredPublication,
  ownerGeneration: number,
  publication: HostedApprovalRuntimePublication
): publication is ActivePublication {
  return (
    publication.state === 'active' &&
    publication.ownerGeneration === ownerGeneration &&
    publication.approvalGeneration === reserved.approvalGeneration &&
    publication.approvalDigest === reserved.approvalDigest &&
    publication.admissionDocumentDigest === reserved.admissionDocumentDigest
  );
}

function isPositiveSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function unavailable(reason: string): HostedApprovalRuntimePublication {
  return Object.freeze({ state: 'unavailable' as const, reason });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeTeamNames(teamNames: readonly string[]): readonly string[] {
  if (teamNames.some((teamName) => !TEAM_NAME.test(teamName))) {
    throw new TypeError('hosted-approval-runtime-team-invalid');
  }
  return [...new Set(teamNames)].toSorted(compareCodeUnits);
}
