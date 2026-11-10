import type { SnippetDiff } from '@shared/types/review';

const MAX_CODEMIRROR_DIFF_COMBINED_BYTES = 2 * 1024 * 1024;
const MAX_CODEMIRROR_DIFF_LINE_PRODUCT = 1_000_000;
const MAX_SNIPPET_PREVIEW_COMBINED_BYTES = 512 * 1024;
const MAX_SNIPPET_PREVIEW_TOTAL_LINES = 4_000;

function countLinesUpTo(text: string, limit: number): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines++;
      if (lines > limit) {
        return lines;
      }
    }
  }
  return lines;
}

export function shouldRenderCodeMirrorReviewDiff(original: string, modified: string): boolean {
  const combinedBytes = original.length + modified.length;
  if (combinedBytes > MAX_CODEMIRROR_DIFF_COMBINED_BYTES) {
    return false;
  }

  const oldLines = countLinesUpTo(original, MAX_CODEMIRROR_DIFF_LINE_PRODUCT + 1);
  const newLines = countLinesUpTo(modified, MAX_CODEMIRROR_DIFF_LINE_PRODUCT + 1);

  return oldLines * newLines <= MAX_CODEMIRROR_DIFF_LINE_PRODUCT;
}

export function shouldRenderSnippetReviewPreview(snippets: SnippetDiff[]): boolean {
  let totalBytes = 0;
  let totalLines = 0;

  for (const snippet of snippets) {
    if (snippet.isError) {
      continue;
    }

    totalBytes += snippet.oldString.length + snippet.newString.length;
    if (totalBytes > MAX_SNIPPET_PREVIEW_COMBINED_BYTES) {
      return false;
    }

    totalLines += countLinesUpTo(snippet.oldString, MAX_SNIPPET_PREVIEW_TOTAL_LINES);
    if (totalLines > MAX_SNIPPET_PREVIEW_TOTAL_LINES) {
      return false;
    }

    totalLines += countLinesUpTo(snippet.newString, MAX_SNIPPET_PREVIEW_TOTAL_LINES);
    if (totalLines > MAX_SNIPPET_PREVIEW_TOTAL_LINES) {
      return false;
    }
  }

  return true;
}
