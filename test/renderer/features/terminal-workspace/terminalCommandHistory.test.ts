import {
  persistTerminalCommandHistory,
  readStoredTerminalCommandHistory,
} from '@features/terminal-workspace/renderer/adapters/terminalCommandHistoryStorage';
import { normalizeStoredTerminalCommandHistoryEntry } from '@features/terminal-workspace/renderer/model/terminalCommandHistory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEAM_NAME = 'terminal-command-history-storage-fixture';
const STORAGE_KEY = `agent-teams:terminal-workspace:${TEAM_NAME}:command-history`;

describe('terminal command history', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes supported shell prompts while retaining the command', () => {
    expect(
      normalizeStoredTerminalCommandHistoryEntry(
        '(venv312) (base) belief@MacBook-Pro-belief terminal-ui-smoke % git status'
      )
    ).toBe('git status');
    expect(
      normalizeStoredTerminalCommandHistoryEntry('(env) C:\\Users\\belief\\project $ pnpm test')
    ).toBe('pnpm test');
  });

  it('drops prompt-only and blank history entries', () => {
    expect(normalizeStoredTerminalCommandHistoryEntry('(venv) ~/project %')).toBeNull();
    expect(normalizeStoredTerminalCommandHistoryEntry('  ')).toBeNull();
  });

  it('preserves ordinary commands containing shell marker characters', () => {
    expect(normalizeStoredTerminalCommandHistoryEntry('shell %')).toBe('shell %');
    expect(normalizeStoredTerminalCommandHistoryEntry('printf "%s" value')).toBe(
      'printf "%s" value'
    );
    expect(normalizeStoredTerminalCommandHistoryEntry('echo cost$estimate')).toBe(
      'echo cost$estimate'
    );
  });

  it('normalizes and caps restored command history', () => {
    const entries = Array.from({ length: 96 }, (_, index) =>
      index % 2 === 0 ? `(env) /fixtures/project % echo ${index}` : `pnpm test ${index}`
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));

    const restored = readStoredTerminalCommandHistory(TEAM_NAME);

    expect(restored).toHaveLength(80);
    expect(restored?.[0]).toBe('echo 16');
    expect(restored?.at(-1)).toBe('pnpm test 95');
  });

  it('persists capped history and ignores corrupt storage', () => {
    const entries = Array.from({ length: 96 }, (_, index) => `command ${index}`);
    persistTerminalCommandHistory(TEAM_NAME, entries);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(
      entries.slice(-80)
    );

    window.localStorage.setItem(STORAGE_KEY, '{broken');
    expect(readStoredTerminalCommandHistory(TEAM_NAME)).toBeNull();
  });

  it('preserves duplicate history entries as an autocomplete frequency signal', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(['pnpm test', 'git status', 'pnpm test'])
    );

    expect(readStoredTerminalCommandHistory(TEAM_NAME)).toEqual([
      'pnpm test',
      'git status',
      'pnpm test',
    ]);
  });

  it('keeps command history isolated by team name', () => {
    persistTerminalCommandHistory('team-a', ['printf TEAM_A']);
    persistTerminalCommandHistory('team-b', ['printf TEAM_B']);

    expect(readStoredTerminalCommandHistory('team-a')).toEqual(['printf TEAM_A']);
    expect(readStoredTerminalCommandHistory('team-b')).toEqual(['printf TEAM_B']);
  });

  it('degrades safely when local storage access throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage read denied');
    });
    expect(readStoredTerminalCommandHistory(TEAM_NAME)).toBeNull();
    vi.restoreAllMocks();

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage write denied');
    });
    expect(() => persistTerminalCommandHistory(TEAM_NAME, ['pnpm test'])).not.toThrow();
  });
});
