import { describe, expect, it, vi } from 'vitest';

import {
  readTeamProvisioningClaudeLogs,
  type TeamProvisioningClaudeLogsPorts,
} from '../TeamProvisioningClaudeLogs';

function createPorts(
  overrides: Partial<TeamProvisioningClaudeLogsPorts> = {}
): TeamProvisioningClaudeLogsPorts {
  return {
    runTracking: {
      getTrackedRunId: vi.fn(() => null),
    },
    runs: new Map(),
    retainedClaudeLogsByTeam: new Map(),
    readPersistedTranscriptClaudeLogs: vi.fn(async () => null),
    ...overrides,
  };
}

describe('TeamProvisioningClaudeLogs', () => {
  it('reads the live run log buffer first', async () => {
    const readPersistedTranscriptClaudeLogs = vi.fn(async () => ({
      lines: ['persisted'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    const ports = createPorts({
      runTracking: { getTrackedRunId: vi.fn(() => 'run-1') },
      runs: new Map([
        [
          'run-1',
          {
            claudeLogLines: ['[stdout]', 'first', '[stderr]', 'boom'],
            claudeLogsUpdatedAt: '2026-02-01T00:00:00.000Z',
          },
        ],
      ]),
      retainedClaudeLogsByTeam: new Map([
        [
          'alpha',
          {
            lines: ['retained'],
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      ]),
      readPersistedTranscriptClaudeLogs,
    });

    await expect(readTeamProvisioningClaudeLogs('alpha', undefined, ports)).resolves.toEqual({
      lines: ['boom', '[stderr]', 'first', '[stdout]'],
      total: 4,
      hasMore: false,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(readPersistedTranscriptClaudeLogs).not.toHaveBeenCalled();
  });

  it('uses retained logs when no live run is available', async () => {
    const ports = createPorts({
      retainedClaudeLogsByTeam: new Map([
        [
          'alpha',
          {
            lines: ['old', 'new'],
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
        ],
      ]),
    });

    await expect(readTeamProvisioningClaudeLogs('alpha', undefined, ports)).resolves.toEqual({
      lines: ['new', 'old'],
      total: 2,
      hasMore: false,
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('falls back to persisted transcript logs', async () => {
    const ports = createPorts({
      readPersistedTranscriptClaudeLogs: vi.fn(async () => ({
        lines: ['one', 'two', 'three'],
        updatedAt: '2026-04-01T00:00:00.000Z',
      })),
    });

    await expect(
      readTeamProvisioningClaudeLogs('alpha', { offset: 1, limit: 1 }, ports)
    ).resolves.toEqual({
      lines: ['two'],
      total: 3,
      hasMore: true,
      updatedAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('returns an empty result when no log source exists', async () => {
    await expect(
      readTeamProvisioningClaudeLogs('missing', undefined, createPorts())
    ).resolves.toEqual({
      lines: [],
      total: 0,
      hasMore: false,
    });
  });
});
