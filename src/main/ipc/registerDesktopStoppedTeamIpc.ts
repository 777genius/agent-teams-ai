import {
  RETAINED_LEGACY_LAUNCH_CHANNEL,
  STOPPED_TEAM_IMPORT_CHANNEL,
} from '@features/agent-backend/contracts';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
// eslint-disable-next-line boundaries/element-types -- Existing Main/preload IPC progress contract.
import { TEAM_PROVISIONING_PROGRESS } from '@preload/constants/ipcChannels';

import type { createDesktopStoppedTeamOperations } from '../composition/createDesktopStoppedTeamOperations';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

type StoppedTeamOperations = ReturnType<typeof createDesktopStoppedTeamOperations>;
type StoppedTeamShell = Parameters<StoppedTeamOperations['retained']>[0] & {
  captureSelection(): { isCurrent(): boolean };
};

/** Both stopped-team routes capture the same authenticated Main shell and renderer selection. */
export function registerDesktopStoppedTeamIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  stoppedTeams: StoppedTeamOperations,
  options: {
    readShell(): StoppedTeamShell | undefined;
    captureContext(event: IpcMainInvokeEvent): string | null;
    getMainWindow(): BrowserWindow | null;
  }
): () => void {
  ipc.handle(STOPPED_TEAM_IMPORT_CHANNEL, (event, request: unknown) => {
    const original = options.readShell(),
      contextSelection = original?.captureSelection(),
      contextId = options.captureContext(event);
    if (!original || !contextId)
      return { ok: false, reason: 'unsupported', outcome: 'not-dispatched' };
    return stoppedTeams.import(
      original,
      contextId,
      request,
      () => contextSelection?.isCurrent() === true && options.captureContext(event) === contextId
    );
  });
  ipc.handle(RETAINED_LEGACY_LAUNCH_CHANNEL, (event, request: unknown) => {
    const original = options.readShell(),
      contextSelection = original?.captureSelection(),
      contextId = options.captureContext(event);
    if (!original || !contextId)
      return { ok: false, reason: 'unavailable', outcome: 'not-dispatched' };
    return stoppedTeams.retained(
      original,
      contextId,
      request,
      () => contextSelection?.isCurrent() === true && options.captureContext(event) === contextId,
      (progress) => {
        if (contextSelection?.isCurrent())
          safeSendToRenderer(options.getMainWindow(), TEAM_PROVISIONING_PROGRESS, progress);
      }
    );
  });
  return () => {
    ipc.removeHandler(STOPPED_TEAM_IMPORT_CHANNEL);
    ipc.removeHandler(RETAINED_LEGACY_LAUNCH_CHANNEL);
  };
}
