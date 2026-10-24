import { digest } from './identity.js';
import { teamRosterRevision } from './rosterSchema.js';
import { validateNativeMemberCreationRecords } from './validateNativeMemberCreation.js';
import type { OwnerState } from './ownerState.js';
import type { TeamMember } from './contracts.js';
import type { TeamSavedSettings } from './rosterContracts.js';

/** Only original additive roster receipts can bridge a captured member across a roster revision. */
export function nativeRosterSuccessor(
  state: OwnerState,
  expectedRevision: string,
  expected: Pick<TeamMember, 'memberId' | 'name' | 'role' | 'settings' | 'delivery'>,
  savedSettings?: TeamSavedSettings
): boolean {
  validateNativeMemberCreationRecords(state);
  const member = state.members.find((row) => row.memberId === expected.memberId);
  if (
    !member?.delivery ||
    !expected.delivery ||
    member.delivery.runId !== expected.delivery.runId ||
    digest({
      memberId: member.memberId,
      name: member.name,
      role: member.role,
      settings: member.settings ?? {},
    }) !==
      digest({
        memberId: expected.memberId,
        name: expected.name,
        role: expected.role,
        settings: expected.settings ?? {},
      }) ||
    digest(state.savedSettings ?? null) !== digest(savedSettings ?? null)
  )
    return false;
  let members = [...state.members],
    version = state.rosterVersion ?? 0;
  for (let remaining = (state.rosterCommands?.length ?? 0) + 1; remaining > 0; remaining--) {
    const current = teamRosterRevision(members, version, state.savedSettings);
    if (current === expectedRevision) return true;
    const receipt = state.rosterCommands?.find(
      (row) => row.nativeCreation && row.revision === current
    );
    const addition = receipt?.nativeCreation;
    if (!addition || version < 1 || addition.member.memberId === expected.memberId) return false;
    const added = members.find((row) => row.memberId === addition.member.memberId);
    if (!added || digest({ ...added, delivery: undefined }) !== digest(addition.member))
      return false;
    members = members.filter((row) => row.memberId !== addition.member.memberId);
    version--;
    if (
      teamRosterRevision(members, version, state.savedSettings) !== addition.expectedRosterRevision
    )
      return false;
  }
  return false;
}
