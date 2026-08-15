import type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './HostedApprovalRuntimeAdmissionPublisher';
import type { HostedApprovalRuntimeTransitionEvidence } from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import type { HostedApprovalRuntimeLifecycleOwner } from './HostedApprovalRuntimeLifecycleOwner';
import type { HostedApprovalRuntimeTransitionService } from './HostedApprovalRuntimeTransitionService';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const OWNER_LEASE_UNAVAILABLE = 'hosted-approval-runtime-owner-lease-unavailable';

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
  constructor(
    private readonly owner: HostedApprovalRuntimeLifecycleOwner,
    private readonly runtime: HostedApprovalRuntimeTransitionService
  ) {}

  async publish(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle,
    ownerLease: HostedApprovalRuntimeOwnerLeaseContract | null
  ): Promise<HostedApprovalRuntimePublication> {
    let requestedLifecycle: HostedApprovalRuntimeLifecycle | null = null;
    let admittedEvidence: HostedApprovalRuntimeTransitionEvidence | null = null;
    try {
      requestedLifecycle = readLifecycle(lifecycle);
      const evidence = await ownerLease?.acquireTransitionEvidence(teamName, lifecycle);
      admittedEvidence = readEvidence(evidence);
    } catch {
      await this.runtime.ensureAbsent(teamName, OWNER_LEASE_UNAVAILABLE);
      return unavailableOwnerLease();
    }
    if (
      !requestedLifecycle ||
      !admittedEvidence ||
      !sameLifecycle(admittedEvidence.lifecycle, requestedLifecycle)
    ) {
      await this.runtime.ensureAbsent(teamName, OWNER_LEASE_UNAVAILABLE);
      return unavailableOwnerLease();
    }

    try {
      const publication = await this.owner.transition(
        teamName,
        Object.freeze({ ...admittedEvidence, lifecycle: requestedLifecycle })
      );
      if (publication.state === 'unavailable') {
        await this.runtime.ensureAbsent(teamName, publication.reason);
      }
      return publication;
    } catch (error) {
      await this.runtime.ensureAbsent(teamName, 'hosted-approval-runtime-transition-failed');
      throw error;
    }
  }

  ensureAbsent(teamName: string, reason: string): Promise<HostedApprovalRuntimePublication> {
    return this.runtime.ensureAbsent(teamName, reason);
  }
}

function readEvidence(value: unknown): HostedApprovalRuntimeTransitionEvidence | null {
  const record = readClosedDataRecord(value, [
    'lifecycle',
    'lease',
    'resolveExpectedInstalledArtifactDigest',
  ]);
  if (!record || typeof record.resolveExpectedInstalledArtifactDigest !== 'function') return null;
  const lifecycle = readLifecycle(record.lifecycle);
  if (!lifecycle || !record.lease || typeof record.lease !== 'object') return null;
  return Object.freeze({
    lifecycle,
    lease: record.lease as HostedApprovalRuntimeTransitionEvidence['lease'],
    resolveExpectedInstalledArtifactDigest:
      record.resolveExpectedInstalledArtifactDigest as HostedApprovalRuntimeTransitionEvidence['resolveExpectedInstalledArtifactDigest'],
  });
}

function readLifecycle(value: unknown): HostedApprovalRuntimeLifecycle | null {
  const stateRecord = readClosedDataRecord(value, ['state', 'ownerGeneration']);
  if (
    stateRecord?.state === 'provisioning' &&
    isPositiveSafeInteger(stateRecord.ownerGeneration)
  ) {
    return Object.freeze({ state: 'provisioning', ownerGeneration: stateRecord.ownerGeneration });
  }

  const restartRecord = readClosedDataRecord(value, [
    'state',
    'ownerGeneration',
    'approvalGeneration',
  ]);
  if (
    restartRecord?.state === 'restart_required' &&
    isPositiveSafeInteger(restartRecord.ownerGeneration) &&
    isPositiveSafeInteger(restartRecord.approvalGeneration)
  ) {
    return Object.freeze({
      state: 'restart_required',
      ownerGeneration: restartRecord.ownerGeneration,
      approvalGeneration: restartRecord.approvalGeneration,
    });
  }

  const activeRecord = readClosedDataRecord(value, [
    'state',
    'ownerGeneration',
    'approvalGeneration',
    'approvalDigest',
  ]);
  if (
    activeRecord?.state === 'active' &&
    isPositiveSafeInteger(activeRecord.ownerGeneration) &&
    isPositiveSafeInteger(activeRecord.approvalGeneration) &&
    typeof activeRecord.approvalDigest === 'string' &&
    SHA256.test(activeRecord.approvalDigest)
  ) {
    return Object.freeze({
      state: 'active',
      ownerGeneration: activeRecord.ownerGeneration,
      approvalGeneration: activeRecord.approvalGeneration,
      approvalDigest: activeRecord.approvalDigest as `sha256:${string}`,
    });
  }
  return null;
}

function readClosedDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object') return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    return null;
  }

  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function sameLifecycle(
  left: HostedApprovalRuntimeLifecycle,
  right: HostedApprovalRuntimeLifecycle
): boolean {
  if (left.state !== right.state || left.ownerGeneration !== right.ownerGeneration) return false;
  if (left.state === 'provisioning' || right.state === 'provisioning') {
    return left.state === right.state;
  }
  if (left.approvalGeneration !== right.approvalGeneration) return false;
  if (left.state === 'restart_required' || right.state === 'restart_required') {
    return left.state === right.state;
  }
  return left.approvalDigest === right.approvalDigest;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function unavailableOwnerLease(): HostedApprovalRuntimePublication {
  return Object.freeze({
    state: 'unavailable',
    reason: OWNER_LEASE_UNAVAILABLE,
  });
}
