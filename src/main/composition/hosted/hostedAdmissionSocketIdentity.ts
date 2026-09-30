import { readHostedAdmissionExactRecord as readExactRecord } from './hostedAdmissionExactRecord';

import type { OrchestratorSocketIdentity } from './hostedLifecycleOrchestratorReadiness';

const DECIMAL_ID_PATTERN = /^\d{1,32}$/u;

export function parseHostedAdmissionSocketIdentity(value: unknown): OrchestratorSocketIdentity {
  const identity = readExactRecord(value, ['device', 'inode', 'uid', 'gid', 'mode']);
  if (
    typeof identity.device !== 'string' ||
    !DECIMAL_ID_PATTERN.test(identity.device) ||
    typeof identity.inode !== 'string' ||
    !DECIMAL_ID_PATTERN.test(identity.inode) ||
    !Number.isSafeInteger(identity.uid) ||
    (identity.uid as number) < 0 ||
    !Number.isSafeInteger(identity.gid) ||
    (identity.gid as number) < 0 ||
    identity.mode !== 0o600
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-socket-identity-invalid');
  }
  return Object.freeze({
    device: identity.device,
    inode: identity.inode,
    uid: identity.uid as number,
    gid: identity.gid as number,
    mode: 0o600,
  });
}

export function sameHostedAdmissionSocketIdentity(
  left: OrchestratorSocketIdentity,
  right: OrchestratorSocketIdentity
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode
  );
}

export function assertSameHostedAdmissionSocketIdentity(
  left: OrchestratorSocketIdentity,
  right: OrchestratorSocketIdentity
): void {
  if (!sameHostedAdmissionSocketIdentity(left, right)) {
    throw new TypeError('hosted-lifecycle-owner-admission-socket-substituted');
  }
}

export function hostedAdmissionSocketIdentityForPath(
  socketPaths: readonly string[],
  socketIdentities: readonly OrchestratorSocketIdentity[],
  socketPath: string | undefined
): OrchestratorSocketIdentity {
  const index = socketPath === undefined ? -1 : socketPaths.indexOf(socketPath);
  const identity = index < 0 ? undefined : socketIdentities[index];
  if (identity === undefined) {
    throw new TypeError('hosted-lifecycle-owner-admission-layout-invalid');
  }
  return identity;
}
