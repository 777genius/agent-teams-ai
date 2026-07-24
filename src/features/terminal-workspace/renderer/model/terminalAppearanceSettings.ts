const TERMINAL_APPEARANCE_SETTINGS_VERSION = 1;

export type TerminalBackgroundMode = 'transparent' | 'solid' | 'image';
export type TerminalBackgroundImageFit = 'cover' | 'contain' | 'stretch' | 'tile' | 'center';

export interface TerminalAppearanceSettings {
  version: number;
  fontSizePx: number;
  opacityPercent: number;
  backgroundMode: TerminalBackgroundMode;
  backgroundColor: string;
  backgroundImageUrl: string;
  backgroundImageFit: TerminalBackgroundImageFit;
  backdropBlurPx: number;
  dimBackgroundImage: boolean;
}

export const DEFAULT_TERMINAL_APPEARANCE_SETTINGS: TerminalAppearanceSettings = {
  version: TERMINAL_APPEARANCE_SETTINGS_VERSION,
  fontSizePx: 15,
  opacityPercent: 74,
  backgroundMode: 'transparent',
  backgroundColor: '#080c14',
  backgroundImageUrl: '',
  backgroundImageFit: 'cover',
  backdropBlurPx: 20,
  dimBackgroundImage: true,
};

export const TERMINAL_BACKGROUND_MODE_OPTIONS: readonly {
  id: TerminalBackgroundMode;
}[] = [{ id: 'transparent' }, { id: 'solid' }, { id: 'image' }];

export const TERMINAL_BACKGROUND_IMAGE_FIT_OPTIONS: readonly {
  id: TerminalBackgroundImageFit;
}[] = [{ id: 'cover' }, { id: 'contain' }, { id: 'stretch' }, { id: 'tile' }, { id: 'center' }];

export function clampTerminalAppearanceNumberInput(
  value: string,
  min: number,
  max: number
): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return min;
  }
  return Math.min(Math.max(Math.round(numberValue), min), max);
}

export function normalizeTerminalAppearanceColor(value: string): string {
  return /^#[\da-f]{6}$/iu.test(value)
    ? value
    : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundColor;
}

export function isTerminalBackgroundMode(value: unknown): value is TerminalBackgroundMode {
  return TERMINAL_BACKGROUND_MODE_OPTIONS.some((option) => option.id === value);
}

export function isTerminalBackgroundImageFit(value: unknown): value is TerminalBackgroundImageFit {
  return TERMINAL_BACKGROUND_IMAGE_FIT_OPTIONS.some((option) => option.id === value);
}
