/**
 * Path parsing utilities for SessionContextPanel.
 */

/**
 * Format the firstSeenInGroup value into a human-readable string.
 * Converts "ai-0" -> "Turn 1", "ai-1" -> "Turn 2", etc.
 */
export function formatFirstSeen(groupId: string): string {
  const turnIndex = parseTurnIndex(groupId);
  if (turnIndex < 0) return groupId;
  return `Turn ${turnIndex + 1}`;
}

/**
 * Extract turn index from groupId. Returns -1 if invalid.
 * "ai-0" -> 0, "ai-1" -> 1, etc.
 */
export function parseTurnIndex(groupId: string): number {
  const match = /^ai-(\d+)$/.exec(groupId);
  if (!match) return -1;
  return parseInt(match[1], 10);
}
