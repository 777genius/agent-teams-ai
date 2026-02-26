import { diffLines } from 'diff';

/**
 * Unified line counting utility using semantic diff.
 * Ensures consistent +/- line counts across all services
 * (MemberStatsComputer, ChangeExtractorService, FileContentResolver).
 *
 * Uses `diffLines()` from npm `diff` package — the same algorithm
 * already used correctly in ChangeExtractorService.countLines()
 * and FileContentResolver.getFileContent().
 */
export function countLineChanges(
  oldStr: string,
  newStr: string
): { added: number; removed: number } {
  if (!oldStr && !newStr) return { added: 0, removed: 0 };
  const changes = diffLines(oldStr, newStr);
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    if (c.added) added += c.count ?? 0;
    if (c.removed) removed += c.count ?? 0;
  }
  return { added, removed };
}
