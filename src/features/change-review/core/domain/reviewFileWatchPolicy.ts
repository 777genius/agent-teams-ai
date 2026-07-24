export function normalizeReviewWatchedFiles(filePaths: unknown): string[] {
  return Array.isArray(filePaths) ? (filePaths as string[]) : [];
}
