import { describe, expect, it } from 'vitest';

import { countCompleteDirectoryConnections } from './connectedCountObservationPolicy';

import type { RuntimeProviderDirectoryDto, RuntimeProviderDirectoryEntryDto } from '../contracts';

const entry = (providerId: string, state: RuntimeProviderDirectoryEntryDto['state']) =>
  ({ providerId, state }) as RuntimeProviderDirectoryEntryDto;
const directory = (filter: 'all' | 'connected' = 'all'): RuntimeProviderDirectoryDto => ({
  runtimeId: 'opencode',
  totalCount: 4,
  returnedCount: 4,
  query: null,
  filter,
  limit: 100,
  cursor: null,
  nextCursor: null,
  entries: [
    entry('opencode', 'connected'),
    entry('openrouter', 'connected'),
    entry('xai', 'connected'),
    entry('local-llama', filter === 'all' ? 'available' : 'connected'),
  ],
  diagnostics: [],
  fetchedAt: new Date().toISOString(),
});

describe('countCompleteDirectoryConnections', () => {
  it('counts provider identities without the OpenCode host or available-only entries', () => {
    expect(countCompleteDirectoryConnections(directory(), 'all')).toBe(2);
    expect(countCompleteDirectoryConnections(directory('connected'), 'connected')).toBe(3);
  });

  it('never treats a short first page or an unvalidated filter as an exact count', () => {
    expect(countCompleteDirectoryConnections({ ...directory(), totalCount: 101 }, 'all')).toBeNull();
    expect(countCompleteDirectoryConnections({ ...directory(), nextCursor: '100' }, 'all')).toBeNull();
    expect(countCompleteDirectoryConnections(directory(), 'connected')).toBeNull();
    expect(countCompleteDirectoryConnections({
      ...directory('connected'),
      entries: [...directory('connected').entries.slice(0, 3), entry('other', 'available')],
    }, 'connected')).toBeNull();
  });

  it('rejects inconsistent pagination, errors, and timed-out inventory probes', () => {
    expect(countCompleteDirectoryConnections({ ...directory(), returnedCount: 3 }, 'all')).toBeNull();
    expect(countCompleteDirectoryConnections({
      ...directory(), diagnostics: ['OpenCode inventory probe timed out after 5000ms'],
    }, 'all')).toBeNull();
    expect(countCompleteDirectoryConnections({
      ...directory(), entries: [...directory().entries.slice(0, 3), entry('other', 'error')],
    }, 'all')).toBeNull();
  });

  it('deduplicates providers independent of case and excludes the OpenCode host', () => {
    const complete = directory();
    expect(countCompleteDirectoryConnections({
      ...complete,
      entries: [entry('OpenRouter', 'connected'), entry('openrouter', 'connected'),
        entry('opencode', 'connected'), entry('other', 'available')],
    }, 'all')).toBe(1);
  });
});
