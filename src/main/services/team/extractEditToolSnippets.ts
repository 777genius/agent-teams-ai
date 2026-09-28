import { parsePatch } from 'diff';

import type { SnippetDiff } from '@shared/types';

interface MetadataChangePath {
  filePath: string;
  kind?: string;
}

interface EditToolContext {
  toolUseId: string;
  timestamp: string;
  isError: boolean;
  includeDetails: boolean;
  normalizeFilePathKey: (filePath: string) => string;
  computeContextHash: (oldString: string, newString: string) => string;
}

function extractMetadataChangePaths(
  input: Record<string, unknown>,
  normalizeFilePathKey: EditToolContext['normalizeFilePathKey']
): MetadataChangePath[] {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const paths: MetadataChangePath[] = [];
  const seen = new Set<string>();

  for (const change of changes) {
    if (!change || typeof change !== 'object') continue;
    const changeObj = change as Record<string, unknown>;
    const filePath = typeof changeObj.path === 'string' ? changeObj.path : '';
    if (!filePath) continue;
    const kind = typeof changeObj.kind === 'string' ? changeObj.kind : undefined;
    const normalized = normalizeFilePathKey(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push({ filePath, ...(kind ? { kind } : {}) });
  }

  return paths;
}

function parseCodexChangeHunks(diff: string): { oldString: string; newString: string }[] | null {
  try {
    const patches = parsePatch(diff);
    if (patches.length !== 1 || patches[0].hunks.length === 0) return null;
    const result: { oldString: string; newString: string }[] = [];
    for (const hunk of patches[0].hunks) {
      const oldLines: string[] = [];
      const newLines: string[] = [];
      let oldHasTrailingNewline = true;
      let newHasTrailingNewline = true;
      let previousMarker: string | null = null;
      for (const line of hunk.lines) {
        if (line === '\\ No newline at end of file') {
          if (previousMarker === '-' || previousMarker === ' ') oldHasTrailingNewline = false;
          if (previousMarker === '+' || previousMarker === ' ') newHasTrailingNewline = false;
          if (previousMarker !== '-' && previousMarker !== '+' && previousMarker !== ' ')
            return null;
          previousMarker = null;
          continue;
        }
        const marker = line[0];
        if (marker === ' ' || marker === '-') oldLines.push(line.slice(1));
        if (marker === ' ' || marker === '+') newLines.push(line.slice(1));
        if (marker !== ' ' && marker !== '-' && marker !== '+') return null;
        previousMarker = marker;
      }
      if (oldLines.length !== hunk.oldLines || newLines.length !== hunk.newLines) return null;
      result.push({
        oldString:
          oldLines.length > 0 ? oldLines.join('\n') + (oldHasTrailingNewline ? '\n' : '') : '',
        newString:
          newLines.length > 0 ? newLines.join('\n') + (newHasTrailingNewline ? '\n' : '') : '',
      });
    }
    return result;
  } catch {
    return null;
  }
}

export function extractEditToolSnippets(
  input: Record<string, unknown>,
  context: EditToolContext
): SnippetDiff[] {
  const oldString = typeof input.old_string === 'string' ? input.old_string : '';
  const newString = typeof input.new_string === 'string' ? input.new_string : '';
  const hasTextPayload =
    typeof input.old_string === 'string' || typeof input.new_string === 'string';
  const metadataPaths = hasTextPayload
    ? []
    : extractMetadataChangePaths(input, context.normalizeFilePathKey);
  const targetPath = typeof input.file_path === 'string' ? input.file_path : '';
  const targetPaths =
    metadataPaths.length > 0 ? metadataPaths : targetPath ? [{ filePath: targetPath }] : [];
  const snippets: SnippetDiff[] = [];

  for (const target of targetPaths) {
    const codexChange = Array.isArray(input.changes)
      ? (input.changes.find(
          (change) =>
            change &&
            typeof change === 'object' &&
            (change as Record<string, unknown>).path === target.filePath
        ) as Record<string, unknown> | undefined)
      : undefined;
    const codexKind = codexChange?.kind;
    const codexKindType =
      typeof codexKind === 'string'
        ? codexKind
        : codexKind && typeof codexKind === 'object'
          ? (codexKind as Record<string, unknown>).type
          : null;
    const codexHunks =
      !hasTextPayload &&
      (codexKindType === 'update' || codexKindType === 'add' || codexKindType === 'delete') &&
      typeof codexChange?.diff === 'string'
        ? parseCodexChangeHunks(codexChange.diff)
        : null;
    const isCodexAdd =
      codexKindType === 'add' &&
      (codexHunks === null || codexHunks.every((pair) => pair.oldString === ''));
    const pairs = codexHunks ?? [{ oldString, newString }];
    for (const pair of pairs) {
      snippets.push({
        toolUseId: context.toolUseId,
        filePath: target.filePath,
        toolName: 'Edit',
        type:
          !hasTextPayload && (isCodexAdd || (codexHunks === null && target.kind === 'add'))
            ? 'write-new'
            : 'edit',
        oldString: pair.oldString,
        newString: pair.newString,
        replaceAll: codexHunks ? false : input.replace_all === true,
        timestamp: context.timestamp,
        isError: context.isError,
        contextHash: context.includeDetails
          ? context.computeContextHash(pair.oldString, pair.newString)
          : undefined,
      });
    }
  }

  return snippets;
}
