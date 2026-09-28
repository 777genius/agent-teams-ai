import { normalizePathForComparison } from '@shared/utils/platformPath';

import type { SnippetDiff } from '@shared/types';

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
    normalizePathForComparison(creation.filePath) === normalizePathForComparison(filePath) &&
    creation.newString.length > 0 &&
    creation.newString === currentContent &&
    Number.isFinite(Date.parse(creation.timestamp))
  );
}
