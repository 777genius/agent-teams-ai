export function resolveChangeReviewFileHunkCount(
  filePath: string,
  snippetsLength: number,
  fileChunkCounts: Readonly<Record<string, number>>
): number {
  return fileChunkCounts[filePath] ?? snippetsLength;
}
