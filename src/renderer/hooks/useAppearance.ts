import { useEffect, useSyncExternalStore } from 'react';

import { api, isElectronMode } from '@renderer/api';
import {
  getAppearanceSnapshot,
  setAppearanceZoom,
  subscribeAppearance,
} from '@renderer/utils/appearancePreferences';

/** One browser-local source of truth for Appearance state; no extra global store. */
export function useAppearancePreferences() {
  return useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
}

/** Applies scale at app root, keeping Electron traffic lights in native coordinates. */
export function useAppearanceZoomController(): void {
  const { zoomPercent } = useAppearancePreferences();

  useEffect(() => {
    if (isElectronMode()) {
      void api.setZoomFactor(zoomPercent / 100).catch((error: unknown) => {
        console.warn('[Appearance] Unable to apply native UI scale', error);
      });
    } else {
      document.documentElement.style.zoom = String(zoomPercent / 100);
    }
  }, [zoomPercent]);

  useEffect(() => {
    if (!isElectronMode()) return;

    // Existing Cmd/Ctrl +/- shortcuts still work. Reflect their result in Settings.
    return api.onZoomFactorChanged((zoomFactor) => {
      const percent = Math.round(zoomFactor * 100);
      if (percent >= 70 && percent <= 200) {
        try {
          setAppearanceZoom(percent);
        } catch {
          // Keyboard zoom must still work if localStorage is unavailable.
        }
      }
    });
  }, []);
}
