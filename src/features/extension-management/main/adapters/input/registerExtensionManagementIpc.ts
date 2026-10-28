import { EXTENSION_MANAGEMENT_METHODS, extensionManagementChannel } from '../../../contracts';

import type { ExtensionManagementFeature } from '../../../core/application/ports';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

export function registerExtensionManagementIpc(
  ipc: IpcMain,
  feature: ExtensionManagementFeature,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  browserAccess?: () => string
): () => void {
  for (const method of EXTENSION_MANAGEMENT_METHODS) {
    ipc.handle(extensionManagementChannel(method), async (event, request: unknown) => {
      if (!trusted(event))
        throw new Error('Extension management request came from an untrusted window.');
      const call = feature[method] as (input: unknown) => Promise<unknown>;
      return call(request);
    });
  }
  ipc.handle(extensionManagementChannel('browserAccess'), (event) => {
    if (!trusted(event) || !browserAccess)
      throw new Error('Browser access requires the owned desktop window.');
    return browserAccess();
  });
  return () => {
    EXTENSION_MANAGEMENT_METHODS.forEach((method) =>
      ipc.removeHandler(extensionManagementChannel(method))
    );
    ipc.removeHandler(extensionManagementChannel('browserAccess'));
  };
}
