import {
  persistTerminalCommandRuns,
  readStoredTerminalCommandRuns,
} from '@features/terminal-workspace/renderer/adapters/terminalCommandRunsStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalCommandRunPresentation } from '@features/terminal-workspace/renderer/model/terminalCommandRuns';

const TEAM_NAME = 'terminal-command-runs-storage-fixture';
const OTHER_TEAM_NAME = 'terminal-command-runs-storage-other-fixture';
const STORAGE_KEY = `agent-teams:terminal-workspace:${TEAM_NAME}:command-runs`;

describe('terminal command runs storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores corrupt and unsupported persisted values', () => {
    window.localStorage.setItem(STORAGE_KEY, '{broken');
    expect(readStoredTerminalCommandRuns(TEAM_NAME)).toEqual([]);

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ command: 'pnpm test' }));
    expect(readStoredTerminalCommandRuns(TEAM_NAME)).toEqual([]);
  });

  it('normalizes recovered runs without restarting interrupted timers', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          clientEventId: ' run-1 ',
          command: ' pnpm test ',
          durationMs: -12,
          exitCode: 1.8,
          paneId: 'pane-1',
          sessionId: 'session-1',
          startedAtMs: 100,
          status: 'running',
        },
        { command: 'missing identity' },
      ])
    );

    expect(readStoredTerminalCommandRuns(TEAM_NAME)).toEqual([
      {
        clientEventId: 'run-1',
        command: 'pnpm test',
        durationMs: 0,
        exitCode: 1,
        paneId: 'pane-1',
        sessionId: 'session-1',
        startedAtMs: 100,
        status: 'unknown',
      },
    ]);
  });

  it('persists only the latest command presentation limit per pane', () => {
    const runs = Array.from({ length: 96 }, (_, index) => createRun(index));

    persistTerminalCommandRuns(TEAM_NAME, runs);

    const stored = readStoredTerminalCommandRuns(TEAM_NAME);
    expect(stored).toHaveLength(80);
    expect(stored[0]?.clientEventId).toBe('run-16');
    expect(stored.at(-1)?.clientEventId).toBe('run-95');
  });

  it('keeps command runs isolated by team storage key', () => {
    const teamRun = createRun(1);
    const otherTeamRun = {
      ...createRun(2),
      clientEventId: 'other-team-run',
      command: 'printf other',
    };

    persistTerminalCommandRuns(TEAM_NAME, [teamRun]);
    persistTerminalCommandRuns(OTHER_TEAM_NAME, [otherTeamRun]);

    expect(readStoredTerminalCommandRuns(TEAM_NAME)).toEqual([teamRun]);
    expect(readStoredTerminalCommandRuns(OTHER_TEAM_NAME)).toEqual([otherTeamRun]);
  });

  it('fails closed when local storage access throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('fixture read failure');
    });

    expect(readStoredTerminalCommandRuns(TEAM_NAME)).toEqual([]);

    getItem.mockRestore();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('fixture write failure');
    });

    expect(() => persistTerminalCommandRuns(TEAM_NAME, [createRun(1)])).not.toThrow();
  });
});

function createRun(index: number): TerminalCommandRunPresentation {
  return {
    clientEventId: `run-${index}`,
    command: `printf ${index}`,
    paneId: 'pane-1',
    sessionId: 'session-1',
    startedAtMs: index,
    status: 'succeeded',
  };
}
