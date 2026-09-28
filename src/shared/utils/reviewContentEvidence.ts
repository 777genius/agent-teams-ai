import { normalizePathForComparison } from '@shared/utils/platformPath';

import type { SnippetDiff } from '@shared/types';

function lexicalReviewPath(filePath: string): string {
  const normalized = normalizePathForComparison(filePath);
  const root = /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/.exec(normalized)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of normalized.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!root) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  const suffix = parts.join('/');
  return suffix ? `${root}${root && !root.endsWith('/') ? '/' : ''}${suffix}` : root || '.';
}

/** Only a native add with a complete, unchanged postimage proves an empty baseline. */
export function hasCapturedCreationPostimage(
  snippets: readonly SnippetDiff[],
  currentContent: string | null,
  filePath: string
): boolean {
  if (currentContent === null) return false;
  const successful = snippets.filter((snippet) => !snippet.isError);
  const creation = successful[0];
  return (
    successful.length === 1 &&
    creation?.type === 'write-new' &&
    creation.toolName === 'Edit' &&
    lexicalReviewPath(creation.filePath) === lexicalReviewPath(filePath) &&
    creation.newString.length > 0 &&
    creation.newString === currentContent &&
    Number.isFinite(Date.parse(creation.timestamp))
  );
}
