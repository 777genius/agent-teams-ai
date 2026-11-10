interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}
const MAX_PATCH_BYTES = 1024 * 1024;
function textLines(text: string): string[] {
  if (text.includes('\r') || text.includes('\0') || (text && !text.endsWith('\n')))
    throw new Error('unsupported-patch-text');
  return text ? text.slice(0, -1).split('\n') : [];
}
function parse(diff: string): Hunk[] {
  if (!diff || Buffer.byteLength(diff) > MAX_PATCH_BYTES) throw new Error('patch-cap');
  const hunks: Hunk[] = [];
  for (const line of textLines(diff)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/u.exec(line);
    if (match) {
      const values = [
        Number(match[1]),
        Number(match[2] ?? 1),
        Number(match[3]),
        Number(match[4] ?? 1),
      ];
      if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
        throw new Error('invalid-hunk');
      hunks.push({
        oldStart: values[0]!,
        oldLines: values[1]!,
        newStart: values[2]!,
        newLines: values[3]!,
        lines: [],
      });
    } else {
      if (!hunks.length || ![' ', '-', '+'].includes(line[0] ?? ''))
        throw new Error('unsupported-patch');
      hunks.at(-1)!.lines.push(line);
    }
  }
  if (!hunks.length) throw new Error('missing-hunks');
  return hunks;
}
function apply(before: string, hunks: readonly Hunk[]): string {
  const source = textLines(before),
    result: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const offset = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (offset < cursor || offset > source.length) throw new Error('hunk-position-mismatch');
    result.push(...source.slice(cursor, offset));
    cursor = offset;
    const nextOffset = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    if (result.length !== nextOffset) throw new Error('hunk-position-mismatch');
    let removed = 0,
      added = 0;
    for (const line of hunk.lines) {
      if (line[0] === ' ' || line[0] === '-') {
        if (source[cursor] !== line.slice(1)) throw new Error('patch-preimage-mismatch');
        cursor++;
        removed++;
      }
      if (line[0] === ' ' || line[0] === '+') {
        result.push(line.slice(1));
        added++;
      }
    }
    if (removed !== hunk.oldLines || added !== hunk.newLines)
      throw new Error('hunk-count-mismatch');
  }
  result.push(...source.slice(cursor));
  const after = result.length ? result.join('\n') + '\n' : '';
  if (Buffer.byteLength(after) > MAX_PATCH_BYTES) throw new Error('file-cap');
  return after;
}
/** No fuzzy offsets, HEAD reconstruction, line-ending conversion or filesystem writes. */
export function applyExactTextUpdatePatch(before: string, diff: string): string {
  const hunks = parse(diff),
    after = apply(before, hunks);
  const inverse = hunks.map((hunk) => ({
    oldStart: hunk.newStart,
    oldLines: hunk.newLines,
    newStart: hunk.oldStart,
    newLines: hunk.oldLines,
    lines: hunk.lines.map((line) =>
      line[0] === '+' ? '-' + line.slice(1) : line[0] === '-' ? '+' + line.slice(1) : line
    ),
  }));
  if (apply(after, inverse) !== before) throw new Error('reverse-patch-mismatch');
  return after;
}
