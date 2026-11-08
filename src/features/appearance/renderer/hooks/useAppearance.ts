import { useEffect, useSyncExternalStore } from 'react';

import { api, isElectronMode } from '@renderer/api';
import {
  getAppearanceSnapshot,
  reflectNativeAppearanceZoom,
  setAppearanceZoom,
  subscribeAppearance,
} from '../adapters/appearanceStore';

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
      const root = document.documentElement;
      root.style.setProperty('--appearance-inverse-zoom', String(100 / zoomPercent));
      root.style.zoom = String(zoomPercent / 100);
      return () => {
        root.style.removeProperty('--appearance-inverse-zoom');
        root.style.zoom = '';
      };
    }
  }, [zoomPercent]);

  useEffect(() => {
    if (!isElectronMode()) return;

    // Existing Cmd/Ctrl +/- shortcuts still work. Reflect their result in Settings.
    return api.onZoomFactorChanged((zoomFactor) => {
      const percent = Math.round(zoomFactor * 100);
      const bounded = Math.max(70, Math.min(200, percent));
      if (bounded !== percent) {
        void api.setZoomFactor(bounded / 100).catch(() => undefined);
      }
      try {
        setAppearanceZoom(bounded);
      } catch {
        // Native zoom has already changed; keep the settings display truthful.
        reflectNativeAppearanceZoom(bounded);
      }
    });
  }, []);
}
