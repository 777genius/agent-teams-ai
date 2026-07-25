import {
  createTerminalWorkspacePreferenceKey,
  persistTerminalAppearanceSettings,
  persistTerminalPreference,
  readStoredTerminalAppearanceSettings,
  readStoredTerminalBooleanPreference,
  readStoredTerminalPreference,
  type TerminalWorkspacePreferencesStorage,
} from '@features/terminal-workspace/renderer/adapters/terminalWorkspacePreferencesStorage';
import { DEFAULT_TERMINAL_APPEARANCE_SETTINGS } from '@features/terminal-workspace/renderer/model/terminalAppearanceSettings';
import { describe, expect, it, vi } from 'vitest';

describe('terminal workspace preferences storage', () => {
  it('isolates preferences and appearance settings by team', () => {
    const storage = createMemoryStorage();
    const teamAAppearance = {
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      backgroundColor: '#112233',
      fontSizePx: 18,
    };
    const teamBAppearance = {
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      backgroundColor: '#445566',
      fontSizePx: 21,
    };

    persistTerminalPreference('team-a', 'theme', 'terminal-platform-light', storage);
    persistTerminalPreference('team-b', 'theme', 'terminal-platform-default', storage);
    persistTerminalPreference('team-a', 'line-wrap', 'true', storage);
    persistTerminalAppearanceSettings('team-a', teamAAppearance, storage);
    persistTerminalAppearanceSettings('team-b', teamBAppearance, storage);

    expect(readStoredTerminalPreference('team-a', 'theme', storage)).toBe(
      'terminal-platform-light'
    );
    expect(readStoredTerminalPreference('team-b', 'theme', storage)).toBe(
      'terminal-platform-default'
    );
    expect(readStoredTerminalBooleanPreference('team-a', 'line-wrap', storage)).toBe(true);
    expect(readStoredTerminalBooleanPreference('team-b', 'line-wrap', storage)).toBeNull();
    expect(readStoredTerminalAppearanceSettings('team-a', storage)).toEqual(teamAAppearance);
    expect(readStoredTerminalAppearanceSettings('team-b', storage)).toEqual(teamBAppearance);
    expect(createTerminalWorkspacePreferenceKey('team-a', 'theme')).not.toBe(
      createTerminalWorkspacePreferenceKey('team-b', 'theme')
    );
  });

  it('falls back safely for corrupt or unavailable storage', () => {
    const corruptStorage = createMemoryStorage();
    corruptStorage.setItem(
      createTerminalWorkspacePreferenceKey('team-a', 'appearance-settings'),
      '{not-json'
    );
    const unavailableStorage: TerminalWorkspacePreferencesStorage = {
      getItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
    };

    expect(readStoredTerminalAppearanceSettings('team-a', corruptStorage)).toBe(
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS
    );
    expect(readStoredTerminalAppearanceSettings('team-a', unavailableStorage)).toBe(
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS
    );
    expect(readStoredTerminalPreference('team-a', 'theme', unavailableStorage)).toBeNull();
    expect(
      readStoredTerminalBooleanPreference('team-a', 'line-wrap', unavailableStorage)
    ).toBeNull();
    expect(() =>
      persistTerminalPreference('team-a', 'theme', 'terminal-platform-light', unavailableStorage)
    ).not.toThrow();
    expect(() =>
      persistTerminalAppearanceSettings(
        'team-a',
        DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
        unavailableStorage
      )
    ).not.toThrow();
  });
});

function createMemoryStorage(): TerminalWorkspacePreferencesStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
