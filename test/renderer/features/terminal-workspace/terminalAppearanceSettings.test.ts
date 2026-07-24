import {
  clampTerminalAppearanceNumberInput,
  DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
  isTerminalBackgroundImageFit,
  isTerminalBackgroundMode,
  normalizeTerminalAppearanceColor,
} from '@features/terminal-workspace/renderer/model/terminalAppearanceSettings';
import { describe, expect, it } from 'vitest';

describe('terminal appearance settings', () => {
  it('clamps numeric form input to the supported setting range', () => {
    expect(clampTerminalAppearanceNumberInput('18.6', 11, 24)).toBe(19);
    expect(clampTerminalAppearanceNumberInput('100', 11, 24)).toBe(24);
    expect(clampTerminalAppearanceNumberInput('invalid', 11, 24)).toBe(11);
  });

  it('normalizes invalid colors to the canonical terminal background', () => {
    expect(normalizeTerminalAppearanceColor('#a1B2c3')).toBe('#a1B2c3');
    expect(normalizeTerminalAppearanceColor('red')).toBe(
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundColor
    );
  });

  it('recognizes only supported background modes and image fits', () => {
    expect(isTerminalBackgroundMode('transparent')).toBe(true);
    expect(isTerminalBackgroundMode('video')).toBe(false);
    expect(isTerminalBackgroundImageFit('tile')).toBe(true);
    expect(isTerminalBackgroundImageFit('zoom')).toBe(false);
  });
});
