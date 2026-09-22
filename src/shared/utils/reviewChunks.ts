import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';

import { computeDiffContextHash } from './diffContextHash';

const CODEMIRROR_DEFAULT_DIFF_CONFIG = { scanLimit: 500 } as const;
const DEFAULT_LINE_SPLIT = /\r\n?|\n/;
const HASH_CONTEXT_LINES = 3;

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

function buildReviewDocuments(
  original: string,
  modified: string
): {
  originalDoc: Text;
  modifiedDoc: Text;
  chunks: readonly Chunk[];
} {
  const originalDoc = Text.of(original.split(DEFAULT_LINE_SPLIT));
  const modifiedDoc = Text.of(modified.split(DEFAULT_LINE_SPLIT));
  return {
    originalDoc,
    modifiedDoc,
    chunks: Chunk.build(originalDoc, modifiedDoc, CODEMIRROR_DEFAULT_DIFF_CONFIG),
  };
}

/**
 * Build the same chunks as CodeMirror's unified merge view with its default diff config.
 * Review decisions use these indexes, so mutation code must not substitute another diff model.
 */
export function buildReviewChunks(original: string, modified: string): readonly Chunk[] {
  return buildReviewDocuments(original, modified).chunks;
}

/** Build stable context hashes keyed by the exact CodeMirror chunk index shown in review UI. */
export function buildReviewChunkContextHashes(
  original: string,
  modified: string
): Record<number, string> {
  const { originalDoc, modifiedDoc, chunks } = buildReviewDocuments(original, modified);
  const hashes: Record<number, string> = {};
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    hashes[index] = computeDiffContextHash(
      buildChunkSideContext(originalDoc, chunk.fromA, chunk.toA),
      buildChunkSideContext(modifiedDoc, chunk.fromB, chunk.toB)
    );
  }
  return hashes;
}

/**
 * Revert selected CodeMirror chunk indexes using the same range semantics as rejectChunk().
 * Returns null when any index is invalid so callers fail closed instead of reverting more text.
 */
export function rejectReviewChunks(
  original: string,
  modified: string,
  chunkIndices: readonly number[]
): string | null {
  const { originalDoc, modifiedDoc, chunks } = buildReviewDocuments(original, modified);
  const uniqueIndices = [...new Set(chunkIndices)];

  if (
    uniqueIndices.length === 0 ||
    uniqueIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= chunks.length)
  ) {
    return null;
  }

  let content = modifiedDoc.toString();
  for (const index of uniqueIndices.sort((a, b) => b - a)) {
    const chunk = chunks[index];
    const insert = buildRejectedChunkContent(originalDoc, modifiedDoc, chunk);
    const to = Math.min(modifiedDoc.length, chunk.toB);
    content = `${content.slice(0, chunk.fromB)}${insert}${content.slice(to)}`;
  }

  return restoreLineEndings(content, detectLineEnding(modified, original));
}

function buildRejectedChunkContent(originalDoc: Text, modifiedDoc: Text, chunk: Chunk): string {
  let insert = originalDoc.sliceString(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
  if (chunk.fromA !== chunk.toA && chunk.toB <= modifiedDoc.length) {
    insert += '\n';
  }
  return insert;
}

function buildChunkSideContext(doc: Text, from: number, to: number): string {
  const safeFrom = Math.min(from, doc.length);
  const safeEnd = Math.min(doc.length, Math.max(safeFrom, to - 1));
  const firstLine = doc.lineAt(safeFrom).number;
  const lastLine = doc.lineAt(safeEnd).number;
  const contextFirstLine = Math.max(1, firstLine - HASH_CONTEXT_LINES);
  const contextLastLine = Math.min(doc.lines, lastLine + HASH_CONTEXT_LINES);
  const context = doc.sliceString(doc.line(contextFirstLine).from, doc.line(contextLastLine).to);

  // The relative anchor disambiguates identical edits whose context windows overlap completely.
  return `${firstLine - contextFirstLine}:${lastLine - contextFirstLine}\n${context}`;
}
