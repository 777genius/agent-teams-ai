import React, { useEffect } from 'react';

import { TooltipProvider } from '@renderer/components/ui/tooltip';

import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ContextSwitchOverlay } from './components/common/ContextSwitchOverlay';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { TabbedLayout } from './components/layout/TabbedLayout';
import { ToolApprovalSheet } from './components/team/ToolApprovalSheet';
import { useTheme } from './hooks/useTheme';
import { api } from './api';
import { useStore } from './store';

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
