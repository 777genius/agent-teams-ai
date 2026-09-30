import {
  INSTANCE_LEASE_PROTOCOL_VERSION,
  type InstanceLeaseAdmissionInspection,
  type InstanceLeaseGuardState,
  type InstanceLeaseLauncherEvidence,
  type VerifiedInstanceLeaseHandle,
} from '../../contracts';

const DECIMAL_KERNEL_ID = /^(?:0|[1-9][0-9]*)$/;

export class InstanceLeaseGuardError extends Error {
  constructor(readonly code: 'invalid_handle' | 'released') {
    super(`instance-lease-guard:${code}`);
    this.name = 'InstanceLeaseGuardError';
  }
}

function isSafePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function snapshotEvidence(evidence: InstanceLeaseLauncherEvidence): InstanceLeaseLauncherEvidence {
  if (
    evidence.protocolVersion !== INSTANCE_LEASE_PROTOCOL_VERSION ||
    !isSafePid(evidence.launcherPid) ||
    !isSafePid(evidence.controllerPid) ||
    !DECIMAL_KERNEL_ID.test(evidence.anchor.device) ||
    !DECIMAL_KERNEL_ID.test(evidence.anchor.inode) ||
    evidence.anchor.inode === '0' ||
    !Number.isSafeInteger(evidence.anchor.mode) ||
    evidence.anchor.mode < 0 ||
    (evidence.anchor.mode & 0o170000) !== 0o100000 ||
    (evidence.anchor.mode & 0o22) !== 0 ||
    !Number.isSafeInteger(evidence.anchor.uid) ||
    evidence.anchor.uid !== 0 ||
    !Number.isSafeInteger(evidence.anchor.linkCount) ||
    evidence.anchor.linkCount !== 1
  ) {
    throw new InstanceLeaseGuardError('invalid_handle');
  }

  return Object.freeze({
    protocolVersion: INSTANCE_LEASE_PROTOCOL_VERSION,
    launcherPid: evidence.launcherPid,
    controllerPid: evidence.controllerPid,
    anchor: Object.freeze({
      device: evidence.anchor.device,
      inode: evidence.anchor.inode,
      mode: evidence.anchor.mode,
      uid: evidence.anchor.uid,
      linkCount: evidence.anchor.linkCount,
    }),
  });
}

/**
 * Process-agnostic ownership gate for the one inherited ADR-16 lease. A guard
 * has no reacquire transition: after release, a new process lifecycle is
 * required before hosted mutation/runtime admission can open again.
 */
export class InstanceLeaseGuard {
  private stateValue: InstanceLeaseGuardState = 'held';
  private readonly evidenceValue: InstanceLeaseLauncherEvidence;

  private constructor(private readonly handle: VerifiedInstanceLeaseHandle) {
    this.evidenceValue = snapshotEvidence(handle.evidence);
  }

  static takeOwnership(handle: VerifiedInstanceLeaseHandle): InstanceLeaseGuard {
    try {
      handle.assertValid();
      return new InstanceLeaseGuard(handle);
    } catch (error) {
      if (error instanceof InstanceLeaseGuardError) {
        throw error;
      }
      throw new InstanceLeaseGuardError('invalid_handle');
    }
  }

  get state(): InstanceLeaseGuardState {
    return this.stateValue;
  }

  get evidence(): InstanceLeaseLauncherEvidence {
    return this.evidenceValue;
  }

  assertHeld(): InstanceLeaseLauncherEvidence {
    if (this.stateValue !== 'held') {
      throw new InstanceLeaseGuardError('released');
    }
    let validationFailed = false;
    let validationError: unknown;
    try {
      this.handle.assertValid();
    } catch (error) {
      validationFailed = true;
      validationError = error;
    }
    if (this.state !== 'held') {
      throw new InstanceLeaseGuardError('released');
    }
    if (validationFailed) {
      throw validationError;
    }
    return this.evidenceValue;
  }

  inspectForAdmission(): InstanceLeaseAdmissionInspection {
    if (this.stateValue === 'released') {
      return Object.freeze({ status: 'released' });
    }
    try {
      this.handle.assertValid();
    } catch {
      return Object.freeze({ status: this.state === 'released' ? 'released' : 'invalid' });
    }
    return this.state === 'released'
      ? Object.freeze({ status: 'released' })
      : Object.freeze({ status: 'held', evidence: this.evidenceValue });
  }

  release(): void {
    if (this.stateValue === 'released') {
      return;
    }
    this.stateValue = 'released';
    this.handle.close();
  }
}
