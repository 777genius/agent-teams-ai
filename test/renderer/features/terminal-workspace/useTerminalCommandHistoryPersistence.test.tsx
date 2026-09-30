import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useTerminalCommandHistoryPersistence } from '@features/terminal-workspace/renderer/hooks/useTerminalCommandHistoryPersistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEAM_A = 'terminal-history-persistence-team-a';
const TEAM_B = 'terminal-history-persistence-team-b';

function HookProbe({
  entries,
  teamName,
}: Readonly<{
  entries: readonly string[];
  teamName: string;
}>): null {
  useTerminalCommandHistoryPersistence({ entries, teamName });
  return null;
}

describe('useTerminalCommandHistoryPersistence', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    host.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('preserves restored history during an empty startup snapshot, then persists runtime changes', async () => {
    const restored = ['git status', 'pnpm test'];
    window.localStorage.setItem(storageKey(TEAM_A), JSON.stringify(restored));

    await renderProbe(TEAM_A, []);
    expect(readHistory(TEAM_A)).toEqual(restored);

    const runtimeEntries = Array.from({ length: 96 }, (_, index) => `command ${index}`);
    await renderProbe(TEAM_A, runtimeEntries);
    expect(readHistory(TEAM_A)).toEqual(runtimeEntries.slice(-80));

    await renderProbe(TEAM_A, []);
    expect(readHistory(TEAM_A)).toEqual([]);
  });

  it('keeps restored histories isolated when the keyed team scope changes', async () => {
    window.localStorage.setItem(storageKey(TEAM_A), JSON.stringify(['printf TEAM_A']));
    window.localStorage.setItem(storageKey(TEAM_B), JSON.stringify(['printf TEAM_B']));

    await renderProbe(TEAM_A, []);
    await renderProbe(TEAM_B, []);

    expect(readHistory(TEAM_A)).toEqual(['printf TEAM_A']);
    expect(readHistory(TEAM_B)).toEqual(['printf TEAM_B']);

    await renderProbe(TEAM_B, ['printf TEAM_B_NEW']);
    expect(readHistory(TEAM_A)).toEqual(['printf TEAM_A']);
    expect(readHistory(TEAM_B)).toEqual(['printf TEAM_B_NEW']);
  });

  async function renderProbe(teamName: string, entries: readonly string[]): Promise<void> {
    await act(async () => {
      root.render(<HookProbe key={teamName} entries={entries} teamName={teamName} />);
      await Promise.resolve();
    });
  }
});

function storageKey(teamName: string): string {
  return `agent-teams:terminal-workspace:${teamName}:command-history`;
}

function readHistory(teamName: string): unknown {
  return JSON.parse(window.localStorage.getItem(storageKey(teamName)) ?? 'null');
}
