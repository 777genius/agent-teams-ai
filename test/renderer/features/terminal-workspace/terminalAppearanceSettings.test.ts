import {
  clampTerminalAppearanceNumberInput,
  DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
  isTerminalBackgroundImageFit,
  isTerminalBackgroundMode,
  normalizeTerminalAppearanceColor,
  normalizeTerminalAppearanceSettings,
  TERMINAL_FONT_SIZE_RANGE,
} from '@features/terminal-workspace/renderer/model/terminalAppearanceSettings';
import { describe, expect, it } from 'vitest';

describe('terminal appearance settings', () => {
  it('clamps numeric form input to the supported setting range', () => {
    expect(clampTerminalAppearanceNumberInput('18.6', TERMINAL_FONT_SIZE_RANGE)).toBe(19);
    expect(clampTerminalAppearanceNumberInput('100', TERMINAL_FONT_SIZE_RANGE)).toBe(24);
    expect(clampTerminalAppearanceNumberInput('invalid', TERMINAL_FONT_SIZE_RANGE)).toBe(11);
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

  it('normalizes persisted settings with canonical defaults and limits', () => {
    expect(
      normalizeTerminalAppearanceSettings({
        backdropBlurPx: -8,
        backgroundColor: 'red',
        backgroundImageFit: 'zoom',
        backgroundImageUrl: 'x'.repeat(2_100),
        backgroundMode: 'video',
        dimBackgroundImage: 'yes',
        fontSizePx: 100,
        opacityPercent: 'invalid',
        version: 99,
      })
    ).toEqual({
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      backdropBlurPx: 0,
      backgroundImageUrl: 'x'.repeat(2_048),
      fontSizePx: 24,
    });
    expect(normalizeTerminalAppearanceSettings(null)).toBe(DEFAULT_TERMINAL_APPEARANCE_SETTINGS);
  });
});
