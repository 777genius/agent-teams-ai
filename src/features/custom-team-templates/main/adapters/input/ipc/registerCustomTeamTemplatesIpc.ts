import { CUSTOM_TEAM_TEMPLATE_CHANNELS } from '../../../../contracts';

import type { CustomTeamTemplatesFeature } from '../../../composition/createCustomTeamTemplatesFeature';
import type { IpcMain } from 'electron';

/**
 * Registers the custom-team-templates IPC channels.
 *
 * Every handler is a one-line forward of the raw payload into the composed use
 * case: the use case owns shape validation and business rules, so the IPC and
 * HTTP adapters cannot drift apart. Each handler answers with a closed typed
 * outcome and never throws, which means a transport failure can never be
 * mistaken for a successful empty library or a completed save.
 */
export function registerCustomTeamTemplatesIpc(
  ipcMain: IpcMain,
  feature: CustomTeamTemplatesFeature
): void {
  ipcMain.handle(CUSTOM_TEAM_TEMPLATE_CHANNELS.preparePreview, (_event, request: unknown) =>
    feature.preparePreview.execute(request)
  );
  ipcMain.handle(CUSTOM_TEAM_TEMPLATE_CHANNELS.saveTemplate, (_event, request: unknown) =>
    feature.saveTemplate.execute(request)
  );
  ipcMain.handle(CUSTOM_TEAM_TEMPLATE_CHANNELS.recheckSave, (_event, request: unknown) =>
    feature.recheckSave.execute(request)
  );
  ipcMain.handle(CUSTOM_TEAM_TEMPLATE_CHANNELS.listTemplates, () =>
    feature.listTemplates.execute()
  );
}

/** Removes every custom-team-templates IPC handler on shutdown. */
export function removeCustomTeamTemplatesIpc(ipcMain: IpcMain): void {
  for (const channel of Object.values(CUSTOM_TEAM_TEMPLATE_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }
}
