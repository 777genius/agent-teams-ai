import { diff3Merge } from 'node-diff3';

export interface ThreeWayTextMergeResult {
  content: string;
  hasConflicts: boolean;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function detectLineEnding(...contents: readonly string[]): '\r\n' | '\r' | '\n' {
  for (const content of contents) {
    const match = /\r\n|\r|\n/.exec(content);
    if (match) return match[0] as '\r\n' | '\r' | '\n';
  }
  return '\n';
}

function restoreLineEndings(content: string, lineEnding: '\r\n' | '\r' | '\n'): string {
  return lineEnding === '\n' ? content : content.replace(/\n/g, lineEnding);
}

/** Merge `theirs` onto `ours` using `base`, preserving independent text edits. */
export function threeWayTextMerge(
  base: string,
  ours: string,
  theirs: string
): ThreeWayTextMergeResult {
  const lineEnding = detectLineEnding(ours, base, theirs);
  const regions = diff3Merge(
    normalizeLineEndings(ours).split('\n'),
    normalizeLineEndings(base).split('\n'),
    normalizeLineEndings(theirs).split('\n')
  );
  let hasConflicts = false;
  const parts: string[] = [];

  for (const region of regions) {
    if (region.ok) {
      parts.push(region.ok.join('\n'));
      continue;
    }
    if (region.conflict) {
      hasConflicts = true;
      parts.push('<<<<<<< current');
      parts.push(region.conflict.a.join('\n'));
      parts.push('=======');
      parts.push(region.conflict.b.join('\n'));
      parts.push('>>>>>>> original');
    }
  }

  return { content: restoreLineEndings(parts.join('\n'), lineEnding), hasConflicts };
}
