import { isLeadMember } from '@shared/utils/leadDetection';

import { resolveOpenCodeSoloMemberIdentityFromDirectory } from '../../provisioning/TeamProvisioningOpenCodeSoloRuntime';

import type { OpenCodeMemberDirectory } from './OpenCodeMemberMessageDeliveryPorts';

/** Lane membership is not lead identity: same-model teammates share primary. */
export function isOpenCodeLeadRecipient(
  memberName: string,
  directory: OpenCodeMemberDirectory
): boolean {
  const normalized = memberName.trim().toLowerCase();
  const members = [...(directory.config?.members ?? []), ...directory.metaMembers];
  return (
    isLeadMember({ name: normalized }) ||
    members.some(
      (member) => member.name.trim().toLowerCase() === normalized && isLeadMember(member)
    ) ||
    resolveOpenCodeSoloMemberIdentityFromDirectory(memberName, directory) !== null
  );
}
