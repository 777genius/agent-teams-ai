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

  // Initialize context system (before notification listeners)
  useEffect(() => {
    void useStore.getState().initializeContextSystem();
  }, []);

  // Refresh available contexts when SSH connection state changes
  useEffect(() => {
    if (!api.ssh?.onStatus) return;
    const cleanup = api.ssh.onStatus(() => {
      void useStore.getState().fetchAvailableContexts();
    });
    return cleanup;
  }, []);

  // Initialize IPC event listeners (notifications, file changes)
  useEffect(() => {
    const cleanup = initializeNotificationListeners();
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
