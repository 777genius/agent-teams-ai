import { extensionManagementChannel } from '../contracts';

import type { ExtensionManagementAPI } from '../contracts';
import type { IpcRenderer } from 'electron';

export function createExtensionManagementBridge(
  ipc: Pick<IpcRenderer, 'invoke'>
): ExtensionManagementAPI {
  return {
    capture: (request) => ipc.invoke(extensionManagementChannel('capture'), request),
    catalog: (request) => ipc.invoke(extensionManagementChannel('catalog'), request),
    detail: (request) => ipc.invoke(extensionManagementChannel('detail'), request),
    discoverSkills: (request) => ipc.invoke(extensionManagementChannel('discoverSkills'), request),
    previewSkill: (request) => ipc.invoke(extensionManagementChannel('previewSkill'), request),
    environment: (request) => ipc.invoke(extensionManagementChannel('environment'), request),
    prepare: (request) => ipc.invoke(extensionManagementChannel('prepare'), request),
    discardPlan: (request) => ipc.invoke(extensionManagementChannel('discardPlan'), request),
    apply: (request) => ipc.invoke(extensionManagementChannel('apply'), request),
    operation: (request) => ipc.invoke(extensionManagementChannel('operation'), request),
    cancel: (request) => ipc.invoke(extensionManagementChannel('cancel'), request),
  };
}
