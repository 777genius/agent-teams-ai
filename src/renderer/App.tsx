import React, { useEffect } from 'react';

import { TooltipProvider } from '@renderer/components/ui/tooltip';

import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ContextSwitchOverlay } from './components/common/ContextSwitchOverlay';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { TabbedLayout } from './components/layout/TabbedLayout';
import { type SplashSceneHandle, startSplashScene } from './components/splash/splashScene';
import { ToolApprovalSheet } from './components/team/ToolApprovalSheet';
import { useTheme } from './hooks/useTheme';
import { api } from './api';
import { useStore } from './store';

declare global {
  interface Window {
    __claudeTeamsSplashEnhancedStartedAt?: number;
    __claudeTeamsSplashScene?: SplashSceneHandle;
    __claudeTeamsSplashStartedAt?: number;
  }
}

const SPLASH_MIN_DURATION_MS = 1600;
const SPLASH_ENHANCED_HOLD_MS = 600;
const SPLASH_FADE_MS = 480;
const SPLASH_REDUCED_MIN_DURATION_MS = 320;
const SPLASH_REDUCED_HOLD_MS = 120;
const SPLASH_REDUCED_FADE_MS = 180;

export const App = (): React.JSX.Element => {
  // Initialize theme on app load
  useTheme();

  // Upgrade the static preload splash, then dismiss it after the scene is visible.
  useEffect(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const scene = window.__claudeTeamsSplashScene ?? startSplashScene(splash, { reducedMotion });
      const startedAt = window.__claudeTeamsSplashStartedAt ?? performance.now();
      const enhancedStartedAt = window.__claudeTeamsSplashEnhancedStartedAt ?? performance.now();
      const elapsed = performance.now() - startedAt;
      const enhancedElapsed = performance.now() - enhancedStartedAt;
      const minDuration = reducedMotion ? SPLASH_REDUCED_MIN_DURATION_MS : SPLASH_MIN_DURATION_MS;
      const enhancedHold = reducedMotion ? SPLASH_REDUCED_HOLD_MS : SPLASH_ENHANCED_HOLD_MS;
      const fadeDuration = reducedMotion ? SPLASH_REDUCED_FADE_MS : SPLASH_FADE_MS;
      const exitDelay = Math.max(minDuration - elapsed, enhancedHold - enhancedElapsed, 0);
      let removeTimer: number | undefined;

      const exitTimer = window.setTimeout(() => {
        splash.classList.add('splash-exiting');
        removeTimer = window.setTimeout(() => {
          scene.stop();
          window.__claudeTeamsSplashScene = undefined;
          window.__claudeTeamsSplashEnhancedStartedAt = undefined;
          splash.remove();
        }, fadeDuration);
      }, exitDelay);

      return () => {
        window.clearTimeout(exitTimer);
        if (removeTimer !== undefined) {
          window.clearTimeout(removeTimer);
        }
      };
    }

    return undefined;
  }, []);

  // Initialize context system lazily when SSH connection state changes.
  // Local-only users never pay the cost of IndexedDB init + context IPC calls.
  useEffect(() => {
    if (!api.ssh?.onStatus) return;
    const cleanup = api.ssh.onStatus(() => {
      void useStore.getState().initializeContextSystem();
      void useStore.getState().fetchAvailableContexts();
    });
    return cleanup;
  }, []);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={150} skipDelayDuration={1500}>
        <ContextSwitchOverlay />
        <TabbedLayout />
        <ConfirmDialog />
        <ToolApprovalSheet />
      </TooltipProvider>
    </ErrorBoundary>
  );
};
