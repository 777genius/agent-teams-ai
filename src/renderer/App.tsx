import React, { useEffect } from 'react';

import { TooltipProvider } from '@renderer/components/ui/tooltip';

import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ContextSwitchOverlay } from './components/common/ContextSwitchOverlay';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { TabbedLayout } from './components/layout/TabbedLayout';
import { useTheme } from './hooks/useTheme';
import { api } from './api';
import { initializeNotificationListeners, useStore } from './store';

export const App = (): React.JSX.Element => {
  // Initialize theme on app load
  useTheme();

  // Dismiss splash screen once React is ready
  useEffect(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 300);
    }
  }, []);

  // Defer IPC-heavy initialization to after the first paint.
  // On Windows, firing 6+ IPC calls simultaneously at startup saturates the
  // UV thread pool (4 threads by default), causing the app to freeze.
  // Context system init is skipped here — local context is ready by default,
  // and SSH context is initialized lazily when SSH connects (see below).
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const timer = setTimeout(() => {
      cleanup = initializeNotificationListeners();
    }, 100);
    return () => {
      clearTimeout(timer);
      cleanup?.();
    };
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
      <TooltipProvider delayDuration={300}>
        <ContextSwitchOverlay />
        <TabbedLayout />
        <ConfirmDialog />
      </TooltipProvider>
    </ErrorBoundary>
  );
};
