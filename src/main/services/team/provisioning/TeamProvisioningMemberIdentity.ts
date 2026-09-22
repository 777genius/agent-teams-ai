import { parseNumericSuffixName } from '@shared/utils/teamMemberName';

export function matchesMemberNameOrBase(candidateName: string, memberName: string): boolean {
  if (candidateName === memberName) {
    return true;
  }
  const parsed = parseNumericSuffixName(candidateName);
  return parsed !== null && parsed.suffix >= 2 && parsed.base === memberName;
}

export function matchesTeamMemberIdentity(leftName: string, rightName: string): boolean {
  return (
    matchesMemberNameOrBase(leftName, rightName) || matchesMemberNameOrBase(rightName, leftName)
  );
}

export function matchesObservedMemberNameForExpected(
  observedName: string,
  expectedName: string
): boolean {
  return matchesMemberNameOrBase(observedName, expectedName);
}

export function matchesExactTeamMemberName(candidateName: string, memberName: string): boolean {
  const left = candidateName.trim().toLowerCase();
  const right = memberName.trim().toLowerCase();
  return left.length > 0 && left === right;
}

export function namesMatchCaseInsensitive(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function isOpenCodeOverlayMemberRemoved(
  metaMembers: readonly { name?: string; removedAt?: unknown }[],
  memberName: string
): boolean {
  return metaMembers.some(
    (member) =>
      typeof member.name === 'string' &&
      namesMatchCaseInsensitive(member.name, memberName) &&
      member.removedAt != null
  );
}
