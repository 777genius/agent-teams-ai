export function normalizeMemberKey(memberName: unknown): string {
  return typeof memberName === 'string' ? memberName.trim().toLowerCase() : '';
}
