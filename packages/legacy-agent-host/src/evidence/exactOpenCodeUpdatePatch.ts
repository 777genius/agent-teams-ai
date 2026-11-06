import { applyExactTextUpdatePatch } from './exactTextUpdatePatch.js';

/** Admit only the native V1 existing-text patch envelope; never fuzzy paths or offsets. */
export function applyExactOpenCodeUpdatePatch(
  before: string,
  patch: string,
  file: string,
  additions: number,
  deletions: number
): string {
  if (Buffer.byteLength(patch) > 1024 * 1024 || patch.includes('\r') || patch.includes('\0'))
    throw new Error('unsupported-native-patch');
  const lines = patch.split('\n');
  if (
    lines[0] !== `Index: ${file}` ||
    !/^={3,}$/u.test(lines[1] ?? '') ||
    lines[2] !== `--- ${file}` ||
    lines[3] !== `+++ ${file}` ||
    ![additions, deletions].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new Error('native-patch-envelope');
  const body = lines.slice(4);
  if (
    body.filter((line) => line.startsWith('+')).length !== additions ||
    body.filter((line) => line.startsWith('-')).length !== deletions
  )
    throw new Error('native-patch-count');
  return applyExactTextUpdatePatch(before, body.join('\n'));
}
