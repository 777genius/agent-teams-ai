import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useAppearanceTypographyController, useAppearanceZoomController } from '@features/appearance/renderer';
import {
  DEFAULT_APPEARANCE, saveAppearance, setAppearanceFontFamily, setAppearanceFontSize, setAppearanceZoom,
} from '@features/appearance/renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@renderer/api', () => ({
  isElectronMode: () => false,
  api: {},
}));

function BrowserAppearance(): null {
  useAppearanceZoomController();
  useAppearanceTypographyController();
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  saveAppearance(DEFAULT_APPEARANCE);
});

afterEach(() => {
  document.documentElement.style.zoom = '';
  document.documentElement.style.removeProperty('--appearance-inverse-zoom');
  document.documentElement.style.removeProperty('--appearance-font-family');
  document.documentElement.style.removeProperty('--appearance-text-scale');
  saveAppearance(DEFAULT_APPEARANCE);
  vi.unstubAllGlobals();
});

it('applies and resets whole-app browser zoom through the mounted React controller', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<BrowserAppearance />));
    expect(document.documentElement.style.zoom).toBe('1');
    expect(document.documentElement.style.getPropertyValue('--appearance-inverse-zoom')).toBe('1');
    for (const zoom of [80, 125, 200, 100]) {
      await act(async () => setAppearanceZoom(zoom));
      expect(document.documentElement.style.zoom).toBe(String(zoom / 100));
      expect(Number(document.documentElement.style.getPropertyValue('--appearance-inverse-zoom'))).toBeCloseTo(100 / zoom, 8);
    }
  } finally {
    await act(async () => root.unmount());
    expect(document.documentElement.style.getPropertyValue('--appearance-inverse-zoom')).toBe('');
    host.remove();
  }
});

it('reactively updates independent typography tokens and restores system defaults', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<BrowserAppearance />));
    expect(document.documentElement.style.getPropertyValue('--appearance-font-family')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--appearance-text-scale')).toBe('1');
    await act(async () => {
      setAppearanceFontFamily('Georgia');
      setAppearanceFontSize(125);
    });
    expect(document.documentElement.style.getPropertyValue('--appearance-font-family')).toContain('"Georgia"');
    expect(document.documentElement.style.getPropertyValue('--appearance-text-scale')).toBe('1.25');
    expect(document.documentElement.style.zoom).toBe('1');
    await act(async () => {
      setAppearanceFontFamily(null);
      setAppearanceFontSize(100);
    });
    expect(document.documentElement.style.getPropertyValue('--appearance-font-family')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--appearance-text-scale')).toBe('1');
  } finally {
    await act(async () => root.unmount());
    expect(document.documentElement.style.getPropertyValue('--appearance-text-scale')).toBe('');
    host.remove();
  }
});
