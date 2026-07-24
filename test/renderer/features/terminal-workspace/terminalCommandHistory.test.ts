import { normalizeStoredTerminalCommandHistoryEntry } from '@features/terminal-workspace/renderer/model/terminalCommandHistory';
import { describe, expect, it } from 'vitest';

describe('terminal command history', () => {
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
});
