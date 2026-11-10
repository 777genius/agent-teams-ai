const RESERVED_MEMBER_NAMES = new Set(['', 'user', 'system']);

export function normalizeMemberName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isReservedMemberName(value: unknown): boolean {
  return RESERVED_MEMBER_NAMES.has(normalizeMemberName(value));
}

export function sameMemberName(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeMemberName(left);
  const normalizedRight = normalizeMemberName(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}
