import { isRecord } from '../utils/valueGuards';

const TERMINAL_APPEARANCE_SETTINGS_VERSION = 1;
const TERMINAL_BACKGROUND_IMAGE_URL_MAX_LENGTH = 2048;

export type TerminalBackgroundMode = 'transparent' | 'solid' | 'image';
export type TerminalBackgroundImageFit = 'cover' | 'contain' | 'stretch' | 'tile' | 'center';

export interface TerminalAppearanceNumberRange {
  min: number;
  max: number;
}

export const TERMINAL_FONT_SIZE_RANGE: TerminalAppearanceNumberRange = {
  min: 11,
  max: 24,
};
export const TERMINAL_OPACITY_RANGE: TerminalAppearanceNumberRange = {
  min: 35,
  max: 100,
};
export const TERMINAL_BACKDROP_BLUR_RANGE: TerminalAppearanceNumberRange = {
  min: 0,
  max: 40,
};

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
  range: TerminalAppearanceNumberRange
): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return range.min;
  }
  return Math.min(Math.max(Math.round(numberValue), range.min), range.max);
}

export function normalizeTerminalAppearanceColor(value: string): string {
  return /^#[\da-f]{6}$/iu.test(value)
    ? value
    : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundColor;
}

export function resolveTerminalBackgroundImageUrl(value: string): string {
  const trimmedValue = value.trim().slice(0, TERMINAL_BACKGROUND_IMAGE_URL_MAX_LENGTH);
  if (!trimmedValue) {
    return '';
  }

  try {
    const url = new URL(trimmedValue);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return '';
    }
    return url.href;
  } catch {
    return '';
  }
}

export function isTerminalBackgroundMode(value: unknown): value is TerminalBackgroundMode {
  return TERMINAL_BACKGROUND_MODE_OPTIONS.some((option) => option.id === value);
}

export function isTerminalBackgroundImageFit(value: unknown): value is TerminalBackgroundImageFit {
  return TERMINAL_BACKGROUND_IMAGE_FIT_OPTIONS.some((option) => option.id === value);
}

export function normalizeTerminalAppearanceSettings(value: unknown): TerminalAppearanceSettings {
  if (!isRecord(value)) {
    return DEFAULT_TERMINAL_APPEARANCE_SETTINGS;
  }

  return {
    version: DEFAULT_TERMINAL_APPEARANCE_SETTINGS.version,
    fontSizePx: clampFiniteNumber(
      value.fontSizePx,
      TERMINAL_FONT_SIZE_RANGE,
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS.fontSizePx
    ),
    opacityPercent: clampFiniteNumber(
      value.opacityPercent,
      TERMINAL_OPACITY_RANGE,
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS.opacityPercent
    ),
    backgroundMode: isTerminalBackgroundMode(value.backgroundMode)
      ? value.backgroundMode
      : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundMode,
    backgroundColor:
      typeof value.backgroundColor === 'string'
        ? normalizeTerminalAppearanceColor(value.backgroundColor)
        : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundColor,
    backgroundImageUrl:
      typeof value.backgroundImageUrl === 'string'
        ? value.backgroundImageUrl.slice(0, TERMINAL_BACKGROUND_IMAGE_URL_MAX_LENGTH)
        : '',
    backgroundImageFit: isTerminalBackgroundImageFit(value.backgroundImageFit)
      ? value.backgroundImageFit
      : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backgroundImageFit,
    backdropBlurPx: clampFiniteNumber(
      value.backdropBlurPx,
      TERMINAL_BACKDROP_BLUR_RANGE,
      DEFAULT_TERMINAL_APPEARANCE_SETTINGS.backdropBlurPx
    ),
    dimBackgroundImage:
      typeof value.dimBackgroundImage === 'boolean'
        ? value.dimBackgroundImage
        : DEFAULT_TERMINAL_APPEARANCE_SETTINGS.dimBackgroundImage,
  };
}

function clampFiniteNumber(
  value: unknown,
  range: TerminalAppearanceNumberRange,
  fallback: number
): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(numberValue), range.min), range.max);
}
