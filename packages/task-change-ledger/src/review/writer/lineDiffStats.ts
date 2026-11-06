import { diffLines } from 'diff';

/** Counts line additions/removals with the npm diffLines semantics used by Changes stats. */
export function countLineChanges(
  oldText: string,
  newText: string
): { added: number; removed: number } {
  if (!oldText && !newText) return { added: 0, removed: 0 };
  if (!oldText) return { added: countTextLines(newText), removed: 0 };
  if (!newText) return { added: 0, removed: countTextLines(oldText) };

  let added = 0;
  let removed = 0;
  for (const change of diffLines(oldText, newText)) {
    if (change.added) added += change.count ?? 0;
    if (change.removed) removed += change.count ?? 0;
  }
  return { added, removed };
}

function countTextLines(value: string): number {
  if (!value) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return value.endsWith('\n') ? lines - 1 : lines;
}
