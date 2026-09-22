export function normalizeReviewWatchedFiles(filePaths: unknown): string[] {
  return Array.isArray(filePaths)
    ? filePaths.filter((filePath): filePath is string => typeof filePath === 'string')
    : [];
}
