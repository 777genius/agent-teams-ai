import path from 'node:path';

import {
  configurePublicationHelper,
  waitForPublicationHelperRetirement,
} from '@features/local-http-auth/main';

import {
  clearTeamControlApiState,
  closeTeamControlApiPublicationAdmission,
} from './TeamControlApiState';

import type { App } from 'electron';

interface QuitWindow {
  isDestroyed(): boolean;
  hide(): void;
}
interface WarningLogger {
  warn(message: string): void;
}

/** Main-only composition. The one-shot helper never imports this module. */
export async function initializeDesktop(
  app: Pick<App, 'isPackaged'>,
  bundleDirectory: string,
): Promise<void> {
  configurePublicationHelper({
    directory: app.isPackaged
      ? path.join(process.resourcesPath, 'local-http-auth')
      : path.resolve(bundleDirectory, '../../dist-local-http-auth'),
    mode: 'electron-node',
  });
  // An inherited endpoint belongs to a previous process, not this Host's server.
  await clearTeamControlApiState();
}

export { closeTeamControlApiPublicationAdmission as closeAdmission };
export { disposePublicationHelper as retire } from '@features/local-http-auth/main';

/** A bounded pending decision retains the broker's physical disposal promise. */
export async function canQuit(
  logger: WarningLogger,
  windows: { getAllWindows(): readonly QuitWindow[] },
): Promise<boolean> {
  if ((await waitForPublicationHelperRetirement()) !== 'closed') {
    logger.warn('Quit deferred: API publication helper retirement is pending');
    return false;
  }
  for (const window of windows.getAllWindows()) {
    if (!window.isDestroyed()) window.hide();
  }
  return true;
}

export async function requireUpdateReady(): Promise<void> {
  if ((await waitForPublicationHelperRetirement()) !== 'closed') {
    throw new Error(
      'Update deferred: API publication helper retirement is pending',
    );
  }
}

export async function shutdownStatus(): Promise<string> {
  return (await waitForPublicationHelperRetirement(0)) === 'closed'
    ? 'Services shut down successfully'
    : 'Service cleanup finished; API publication helper retirement is pending';
}
