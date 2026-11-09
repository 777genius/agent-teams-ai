import assert from 'node:assert/strict';

export interface ProviderDirectoryRow {
  providerId: string;
  state: string;
}

export interface ProviderDirectoryPage {
  runtimeId: string;
  totalCount: number;
  returnedCount: number;
  filter: string;
  cursor: string | null;
  nextCursor: string | null;
  query: string | null;
  entries: ProviderDirectoryRow[];
  diagnostics: string[];
  fetchedAt: string;
}

/** CLI verification only. Never claims a model can launch or that auth is valid. */
export function parseProviderDirectory(
  output: string,
  filter: 'all' | 'connected',
  cursor: string | null = null,
): ProviderDirectoryPage {
  assert(output.length < 6 * 1024 * 1024, 'Runtime JSON response too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error('Runtime stdout is not a single valid JSON value');
  }
  assert(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
  const envelope = parsed as Record<string, unknown>;
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.runtimeId, 'opencode');
  assert.equal(envelope.error, undefined, 'Genuine runtime refused directory read');
  const directory = envelope.directory as ProviderDirectoryPage | undefined;
  assert(directory !== undefined && typeof directory === 'object');
  assert.equal(directory.runtimeId, 'opencode');
  assert.equal(directory.filter, filter);
  assert.equal(directory.query, null);
  assert.equal(directory.cursor, cursor);
  assert(Number.isSafeInteger(directory.totalCount) && directory.totalCount >= 0);
  assert(Number.isSafeInteger(directory.returnedCount) && directory.returnedCount >= 0);
  assert(Array.isArray(directory.entries) && directory.entries.length <= 100);
  assert.equal(directory.returnedCount, directory.entries.length);
  assert(directory.totalCount >= directory.entries.length);
  assert(Array.isArray(directory.diagnostics));
  assert(Number.isFinite(Date.parse(directory.fetchedAt)));
  const seen = new Set<string>();
  for (const entry of directory.entries) {
    assert(typeof entry.providerId === 'string' && entry.providerId.trim() !== '');
    assert(typeof entry.state === 'string');
    const id = entry.providerId.trim().toLowerCase();
    assert(!seen.has(id), 'Duplicate normalized provider identity on page');
    seen.add(id);
    if (filter === 'connected') assert.equal(entry.state, 'connected');
  }
  assert(directory.nextCursor === null ||
    (typeof directory.nextCursor === 'string' && /^\d+$/.test(directory.nextCursor)));
  if (directory.nextCursor === null) {
    assert.equal(Number(cursor ?? '0') + directory.entries.length, directory.totalCount);
  } else {
    assert.equal(Number(directory.nextCursor), Number(cursor ?? '0') + directory.entries.length);
    assert(Number(directory.nextCursor) < directory.totalCount);
  }
  // Never turn timed-out or partial observations into an authoritative count.
  assert(!directory.diagnostics.some((message) =>
    typeof message === 'string' &&
    /timed?\s*out|timeout|partial|incomplete|probe failed|unavailable/i.test(message)
  ), 'Directory contains incomplete inventory diagnostics');
  return directory;
}

export function connectedProviderIds(rows: readonly ProviderDirectoryRow[]): string[] {
  return [...new Set(rows.filter((entry) => entry.state === 'connected')
    .map((entry) => entry.providerId.trim().toLowerCase())
    .filter((id) => id && id !== 'opencode'))].sort();
}

/** A stable count does not prove the same authenticated providers remain connected. */
export function assertStableConnectedProviders(
  original: readonly ProviderDirectoryRow[],
  warm: readonly ProviderDirectoryRow[],
): void {
  assert.deepEqual(
    connectedProviderIds(warm), connectedProviderIds(original),
    'Connected identities changed without a credential mutation',
  );
}

export function completeConnectedCount(page: ProviderDirectoryPage): number | null {
  if (page.nextCursor !== null || page.entries.length !== page.totalCount) return null;
  return connectedProviderIds(page.entries).length;
}

export function validateConnectedSummary(
  all: ProviderDirectoryPage,
  connected: ProviderDirectoryPage,
): number {
  assert.equal(all.filter, 'all');
  assert.equal(connected.filter, 'connected');
  const connectedCount = completeConnectedCount(connected);
  assert(connectedCount !== null, 'Connected summary is incomplete');
  // The filtered page must include every connected identity visible in the
  // unfiltered first page, even when there are >100 total providers.
  const allFirstPageConnections = connectedProviderIds(all.entries);
  const connectedSet = new Set(connectedProviderIds(connected.entries));
  for (const id of allFirstPageConnections) {
    assert(connectedSet.has(id), 'Filtered summary lost a connected identity');
  }
  if (all.nextCursor === null) {
    assert.equal(connectedCount, connectedProviderIds(all.entries).length);
  }
  return connectedCount;
}
