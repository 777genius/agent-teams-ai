import * as path from 'path';

import type { FileChangeSummary, SnippetDiff } from '@shared/types/review';

export type AuthoritativeReviewFiles = Map<string, FileChangeSummary[]>;

export function normalizeReviewPathForIdentity(filePath: string): string {
  return path.resolve(path.normalize(filePath));
}

export function collectAuthoritativeReviewedFiles(
  files: FileChangeSummary[]
): AuthoritativeReviewFiles {
  const reviewedFiles: AuthoritativeReviewFiles = new Map();
  for (const file of files) {
    for (const filePath of [file.filePath, ...file.snippets.map((snippet) => snippet.filePath)]) {
      if (!filePath || !path.isAbsolute(path.normalize(filePath))) continue;
      const key = normalizeReviewPathForIdentity(filePath);
      const owners = reviewedFiles.get(key) ?? [];
      if (!owners.includes(file)) owners.push(file);
      reviewedFiles.set(key, owners);
    }
  }
  return reviewedFiles;
}

export function getAuthoritativeReviewedFile(
  authorization: {
    reviewedFiles: AuthoritativeReviewFiles | null;
    selectedReviewKeys?: ReadonlyMap<string, string>;
  },
  filePath: string,
  reviewKey?: string
): FileChangeSummary {
  const files = authorization.reviewedFiles?.get(normalizeReviewPathForIdentity(filePath)) ?? [];
  const selectedKey =
    reviewKey ?? authorization.selectedReviewKeys?.get(normalizeReviewPathForIdentity(filePath));
  if (files.length === 0) throw new Error('File is not part of the reviewed scope');
  if (selectedKey !== undefined) {
    const matches = files.filter(
      (file) =>
        normalizeReviewPathForIdentity(file.filePath) ===
          normalizeReviewPathForIdentity(filePath) &&
        (file.changeKey ?? file.filePath) === selectedKey
    );
    if (matches.length !== 1) {
      throw new Error('Durable reviewKey does not match the authoritative review identity');
    }
    return matches[0];
  }
  if (files.length !== 1) throw new Error('Ambiguous reviewed file; reviewKey is required');
  return files[0];
}

export function getDisplayedReviewedFile(
  reviewedFiles: AuthoritativeReviewFiles | null,
  filePath: string,
  snippets: SnippetDiff[]
): FileChangeSummary | null {
  const files = reviewedFiles?.get(normalizeReviewPathForIdentity(filePath)) ?? [];
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  const matches = files.filter(
    (file) =>
      normalizeReviewPathForIdentity(file.filePath) === normalizeReviewPathForIdentity(filePath) &&
      JSON.stringify(file.snippets) === JSON.stringify(snippets)
  );
  if (matches.length !== 1) throw new Error('Ambiguous displayed review identity');
  return matches[0];
}
