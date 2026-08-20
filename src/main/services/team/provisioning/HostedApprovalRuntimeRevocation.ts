import {
  descriptorAnchoredUnlink,
  validateTrustedDirectoryCapability,
} from './HostedApprovalRuntimeDescriptorStorage';

import type { HostedApprovalRuntimeAdmissionPublisherPorts } from './HostedApprovalRuntimeAdmissionPublisher';

export async function revokeHostedApprovalRuntimeAdmission(
  teamName: string,
  reason: string,
  admissionFile: string,
  ports: Pick<HostedApprovalRuntimeAdmissionPublisherPorts, 'openTeamDirectory' | 'stateStore'>
) {
  if (!teamName.trim()) throw new TypeError('hosted-approval-runtime-team-invalid');
  const directory = await ports.openTeamDirectory(teamName);
  await validateTrustedDirectoryCapability(directory);
  let removed = false;
  try {
    await ports.stateStore.withCommitLock(teamName, async () => {
      try {
        removed = await descriptorAnchoredUnlink(directory, admissionFile);
      } catch (error) {
        throw new Error('hosted-approval-runtime-revocation-unconfirmed', { cause: error });
      }
    });
  } finally {
    await directory.handle.close();
  }
  return Object.freeze({ state: removed ? ('revoked' as const) : ('absent' as const), reason });
}
