import { createLogger } from '@shared/utils/logger';
import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';

import type { AppCloseReadinessResult } from '@features/app-close-coordination/contracts';

const logger = createLogger('App');

export function formatCloseReadinessBlockers(
  results: readonly AppCloseReadinessResult[]
): string[] {
  return results.flatMap((result) => result.blockers).slice(0, 10);
}

export async function confirmUnsafeAppClose(
  window: BrowserWindow,
  blockers: readonly string[],
  unsafeActionLabel: string
): Promise<boolean> {
  if (window.isDestroyed()) return false;
  window.show();
  window.focus();
  const detail =
    blockers.length > 0
      ? blockers.map((blocker) => `- ${blocker}`).join('\n')
      : 'Changes did not confirm that its latest state was saved.';
  const choice = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Changes is not ready to close',
    message: 'Some Changes state may not be saved yet.',
    detail,
    buttons: ['Keep Open', unsafeActionLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return choice.response === 1;
}

interface DesktopWindowCloseDecision {
  readonly platform: NodeJS.Platform;
  readonly remainingWindowCount: number;
  readonly hasActiveTeamRuntimes: boolean;
  readonly showDockIcon: boolean;
}

interface ActiveTeamRuntimeReader {
  hasActiveTeamRuntimes(): boolean;
}

export function hasActiveTeamRuntimesForWindowClose(
  servicesReady: boolean,
  teamRuntimeReader: ActiveTeamRuntimeReader | null | undefined
): boolean {
  if (!servicesReady || !teamRuntimeReader) {
    return false;
  }

  try {
    return teamRuntimeReader.hasActiveTeamRuntimes();
  } catch (error) {
    logger.warn(
      `Failed to check active team runtimes before closing last window: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

interface DesktopWindowCloseLifecycleActions {
  isWindowUsable: () => boolean;
  shouldQuitAfterClose: () => boolean;
  requestAppQuit: () => Promise<boolean>;
  requestWindowCloseReadiness: () => Promise<boolean>;
  authorizeWindowClose: () => void;
  closeWindow: () => void;
}

export function shouldQuitAfterDesktopWindowClose(decision: DesktopWindowCloseDecision): boolean {
  if (decision.remainingWindowCount > 0) return false;
  return decision.hasActiveTeamRuntimes || decision.platform !== 'darwin' || !decision.showDockIcon;
}

export async function runDesktopWindowCloseLifecycle(
  actions: DesktopWindowCloseLifecycleActions
): Promise<boolean> {
  if (!actions.isWindowUsable()) return false;
  if (actions.shouldQuitAfterClose()) {
    return actions.requestAppQuit();
  }
  if (!(await actions.requestWindowCloseReadiness()) || !actions.isWindowUsable()) return false;
  actions.authorizeWindowClose();
  actions.closeWindow();
  return true;
}

type DesktopQuitReason = 'app-quit' | 'relaunch';

interface DesktopQuitLifecycleActions {
  flushConfig: () => Promise<void>;
  shutdownServices: () => Promise<void>;
  reportShutdownFailure: (error: unknown) => void | Promise<void>;
  prepareToQuit: () => void;
  markShutdownComplete: () => void;
  relaunch: () => void;
  quit: () => void;
}

interface DesktopUpdateInstallLifecycleActions {
  flushConfig: () => Promise<void>;
  shutdownServices: () => Promise<void>;
  reportShutdownFailure: (error: unknown) => void | Promise<void>;
  markShutdownComplete: () => void;
}

export async function runDesktopQuitLifecycle(
  reason: DesktopQuitReason,
  actions: DesktopQuitLifecycleActions
): Promise<boolean> {
  try {
    await actions.flushConfig();
    await actions.shutdownServices();
  } catch (error) {
    await actions.reportShutdownFailure(error);
    return false;
  }

  actions.prepareToQuit();
  actions.markShutdownComplete();
  if (reason === 'relaunch') actions.relaunch();
  actions.quit();
  return true;
}

export async function runDesktopUpdateInstallLifecycle(
  actions: DesktopUpdateInstallLifecycleActions
): Promise<void> {
  try {
    await actions.flushConfig();
    await actions.shutdownServices();
  } catch (error) {
    await actions.reportShutdownFailure(error);
    throw error;
  }

  actions.markShutdownComplete();
}

export async function reportDesktopShutdownFailure(
  reason: DesktopQuitReason | 'update-install',
  error: unknown
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const actionLabel =
    reason === 'relaunch' ? 'relaunch' : reason === 'update-install' ? 'update install' : 'quit';
  logger.error(
    reason === 'update-install'
      ? `Shutdown before update install failed: ${errorMessage}`
      : `Shutdown failed: ${errorMessage}`
  );

  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  try {
    const options: MessageBoxOptions = {
      type: 'error',
      title: 'Changes could not finish shutting down',
      message: `The ${actionLabel} was canceled because app data could not be saved.`,
      detail: errorMessage,
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    if (window) {
      window.show();
      window.focus();
      await dialog.showMessageBox(window, options);
    } else {
      await dialog.showMessageBox(options);
    }
  } catch (dialogError) {
    logger.error(
      `Failed to show shutdown error: ${
        dialogError instanceof Error ? dialogError.message : String(dialogError)
      }`
    );
  }
}
