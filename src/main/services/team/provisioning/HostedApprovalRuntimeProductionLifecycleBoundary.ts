import type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './HostedApprovalRuntimeAdmissionPublisher';
import type { HostedApprovalRuntimeTransitionEvidence } from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import type { HostedApprovalRuntimeLifecycleOwner } from './HostedApprovalRuntimeLifecycleOwner';
import type { HostedApprovalRuntimeTransitionService } from './HostedApprovalRuntimeTransitionService';

export interface HostedApprovalRuntimeOwnerLeaseContract {
  acquireTransitionEvidence(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimeTransitionEvidence | null>;
}

/**
 * Authoritative product lifecycle input. The external owner supplies a single-use binding lease;
 * this boundary never reconstructs authority from team files or ambient process state.
 */
export class HostedApprovalRuntimeProductionLifecycleBoundary {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly issuedTransitions = new Map<string, number>();

  constructor(
    private readonly owner: HostedApprovalRuntimeLifecycleOwner,
    private readonly runtime: HostedApprovalRuntimeTransitionService
  ) {}

  async publish(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle,
    ownerLease: HostedApprovalRuntimeOwnerLeaseContract | null
  ): Promise<HostedApprovalRuntimePublication> {
    const key = teamName.trim();
    const ticket = (this.issuedTransitions.get(key) ?? 0) + 1;
    this.issuedTransitions.set(key, ticket);
    return this.serialized(key, () =>
      this.publishSerialized(key, lifecycle, ownerLease, ticket)
    );
  }

  private async publishSerialized(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle,
    ownerLease: HostedApprovalRuntimeOwnerLeaseContract | null,
    ticket: number
  ): Promise<HostedApprovalRuntimePublication> {
    let evidence: HostedApprovalRuntimeTransitionEvidence | null | undefined;
    try {
      evidence = await ownerLease?.acquireTransitionEvidence(teamName, lifecycle);
      const requestedLifecycle = normalizeLifecycle(lifecycle);
      const evidenceLifecycle = normalizeLifecycle(evidence?.lifecycle);
      if (
        !evidence ||
        !evidence.lease ||
        typeof evidence.lease.token !== 'string' ||
        !evidence.lease.token.trim() ||
        typeof evidence.lease.consume !== 'function' ||
        typeof evidence.resolveExpectedInstalledArtifactDigest !== 'function' ||
        JSON.stringify(evidenceLifecycle) !== JSON.stringify(requestedLifecycle) ||
        this.issuedTransitions.get(teamName) !== ticket
      ) {
        throw new TypeError('hosted-approval-runtime-owner-lease-invalid');
      }
      evidence = Object.freeze({ ...evidence, lifecycle: evidenceLifecycle });
    } catch {
      await this.runtime.ensureAbsent(teamName, 'hosted-approval-runtime-owner-lease-unavailable');
      return unavailableOwnerLease();
    }

    try {
      const publication = await this.owner.transition(teamName, evidence);
      if (publication.state === 'unavailable') {
        await this.runtime.ensureAbsent(teamName, publication.reason);
      }
      return publication;
    } catch (error) {
      await this.runtime.ensureAbsent(teamName, 'hosted-approval-runtime-transition-failed');
      throw error;
    }
  }

  private serialized<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(teamName) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.queues.set(teamName, next);
    const cleanup = () => {
      if (this.queues.get(teamName) === next) {
        this.queues.delete(teamName);
        this.issuedTransitions.delete(teamName);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}

function normalizeLifecycle(value: unknown): HostedApprovalRuntimeLifecycle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-approval-runtime-lifecycle-invalid');
  }
  const candidate = value as Record<string, unknown>;
  const ownerGeneration = positiveSafeInteger(candidate.ownerGeneration);
  if (candidate.state === 'provisioning' && hasExactKeys(candidate, ['state', 'ownerGeneration'])) {
    return Object.freeze({ state: 'provisioning', ownerGeneration });
  }
  const approvalGeneration = positiveSafeInteger(candidate.approvalGeneration);
  if (
    candidate.state === 'restart_required' &&
    hasExactKeys(candidate, ['state', 'ownerGeneration', 'approvalGeneration'])
  ) {
    return Object.freeze({ state: 'restart_required', ownerGeneration, approvalGeneration });
  }
  if (
    candidate.state === 'active' &&
    hasExactKeys(candidate, [
      'state',
      'ownerGeneration',
      'approvalGeneration',
      'approvalDigest',
    ]) &&
    typeof candidate.approvalDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(candidate.approvalDigest)
  ) {
    return Object.freeze({
      state: 'active',
      ownerGeneration,
      approvalGeneration,
      approvalDigest: candidate.approvalDigest as `sha256:${string}`,
    });
  }
  throw new TypeError('hosted-approval-runtime-lifecycle-invalid');
}

function positiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('hosted-approval-runtime-lifecycle-invalid');
  }
  return value as number;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function unavailableOwnerLease(): HostedApprovalRuntimePublication {
  return Object.freeze({
    state: 'unavailable',
    reason: 'hosted-approval-runtime-owner-lease-unavailable',
  });
}
