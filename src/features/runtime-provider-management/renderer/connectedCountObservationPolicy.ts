import type { RuntimeProviderDirectoryDto } from '../contracts';

/**
 * A complete directory observation can tell us how many provider identities are
 * connected. This is display data, never proof that models or launches work.
 */
export function countCompleteDirectoryConnections(
  directory: RuntimeProviderDirectoryDto | null | undefined,
  filter: 'all' | 'connected'
): number | null {
  if (
    !directory ||
    directory.runtimeId !== 'opencode' ||
    directory.query != null ||
    directory.filter !== filter ||
    directory.cursor != null ||
    directory.nextCursor != null ||
    !Number.isSafeInteger(directory.totalCount) ||
    directory.totalCount < 0 ||
    directory.totalCount !== directory.entries.length ||
    directory.returnedCount !== directory.entries.length ||
    directory.entries.some((entry) => entry.state === 'error') ||
    directory.diagnostics.some((message) =>
      /timed?\s*out|timeout|partial|incomplete|probe failed|unavailable/i.test(message)
    ) ||
    (filter === 'connected' && directory.entries.some((entry) => entry.state !== 'connected'))
  ) return null;

  return new Set(
    directory.entries
      .filter((entry) => entry.state === 'connected')
      .map((entry) => entry.providerId.trim().toLowerCase())
      .filter((id) => id && id !== 'opencode')
  ).size;
}
