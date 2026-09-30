import {
  normalizeTerminalAppearanceSettings,
  resolveTerminalBackgroundImageUrl,
  type TerminalAppearanceSettings,
  type TerminalBackgroundImageFit,
} from '../model/terminalAppearanceSettings';

import type { CSSProperties } from 'react';

export function createTerminalAppearanceStyle(settings: TerminalAppearanceSettings): CSSProperties {
  const normalizedSettings = normalizeTerminalAppearanceSettings(settings);
  const imageUrl = resolveTerminalBackgroundImageUrl(normalizedSettings.backgroundImageUrl);
  const hasImage = normalizedSettings.backgroundMode === 'image' && imageUrl.length > 0;

  return {
    '--agent-terminal-font-size': `${normalizedSettings.fontSizePx}px`,
    '--agent-terminal-panel-opacity': String(normalizedSettings.opacityPercent / 100),
    '--agent-terminal-background-color': normalizedSettings.backgroundColor,
    '--agent-terminal-background-image': hasImage ? createCssUrl(imageUrl) : 'none',
    '--agent-terminal-background-position': getTerminalBackgroundPosition(
      normalizedSettings.backgroundImageFit
    ),
    '--agent-terminal-background-repeat': getTerminalBackgroundRepeat(
      normalizedSettings.backgroundImageFit
    ),
    '--agent-terminal-background-size': getTerminalBackgroundSize(
      normalizedSettings.backgroundImageFit
    ),
    '--agent-terminal-backdrop-blur': `${normalizedSettings.backdropBlurPx}px`,
    '--agent-terminal-background-image-blur': hasImage
      ? `${normalizedSettings.backdropBlurPx}px`
      : '0px',
    '--agent-terminal-image-dim-opacity':
      hasImage && normalizedSettings.dimBackgroundImage ? '0.42' : '0',
  } as CSSProperties;
}

function createCssUrl(value: string): string {
  return `url("${value.replace(/["\\\n\r]/gu, '')}")`;
}

function getTerminalBackgroundSize(fit: TerminalBackgroundImageFit): string {
  if (fit === 'stretch') return '100% 100%';
  if (fit === 'tile' || fit === 'center') return 'auto';
  return fit;
}

function getTerminalBackgroundRepeat(fit: TerminalBackgroundImageFit): string {
  return fit === 'tile' ? 'repeat' : 'no-repeat';
}

function getTerminalBackgroundPosition(fit: TerminalBackgroundImageFit): string {
  return fit === 'tile' ? 'top left' : 'center';
}
