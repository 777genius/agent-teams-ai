import { digest } from './identity.js';
import { teamRosterRevision } from './rosterSchema.js';
import { validateNativeMemberCreationRecords } from './validateNativeMemberCreation.js';
import { validateLiveRosterMembership } from './liveRosterMembership.js';
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
  validateLiveRosterMembership(state);
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
  const live = (state.rosterCommands ?? []).flatMap(row => row.liveMembership
    ? [row.liveMembership.publication, row.liveMembership.compensation].filter(edge => edge !== undefined)
      .map(edge => ({ targetId: row.liveMembership!.delta.targetId, edge: edge! })) : []);
  const product = (row: TeamMember | null | undefined) => row ? {
    memberId: row.memberId, name: row.name, role: row.role, settings: row.settings ?? {},
  } : null;
  for (let remaining = (state.rosterCommands?.length ?? 0) + live.length + 1; remaining > 0; remaining--) {
    const current = teamRosterRevision(members, version, state.savedSettings);
    if (current === expectedRevision) return true;
    const native = state.rosterCommands?.filter(
      (row) => row.nativeCreation && row.revision === current
    ) ?? [];
    const changes = live.filter(row => row.edge.afterRevision === current);
    if (native.length + changes.length !== 1) return false;
    if (changes.length) {
      const { targetId, edge } = changes[0]!;
      if (targetId === expected.memberId || version !== edge.afterVersion ||
          edge.beforeVersion + 1 !== version ||
          digest(product(members.find(row => row.memberId === targetId))) !== digest(product(edge.after))) return false;
      members = members.filter(row => row.memberId !== targetId);
      if (edge.before) members.splice(edge.position, 0, structuredClone(edge.before));
      version = edge.beforeVersion;
      if (teamRosterRevision(members, version, state.savedSettings) !== edge.beforeRevision) return false;
      continue;
    }
    const receipt = native[0];
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
