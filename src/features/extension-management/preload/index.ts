import { extensionManagementChannel } from '../contracts';

import type { ExtensionManagementAPI } from '../contracts';
import type { IpcRenderer } from 'electron';

export function createExtensionManagementBridge(
  ipc: Pick<IpcRenderer, 'invoke'>
): ExtensionManagementAPI {
  return {
    browserAccess: () => ipc.invoke(extensionManagementChannel('browserAccess')),
    previewSkillCopy: (request) =>
      ipc.invoke(extensionManagementChannel('previewSkillCopy'), request),
    skillCopySources: (request) =>
      ipc.invoke(extensionManagementChannel('skillCopySources'), request),
    hostStatus: () => ipc.invoke(extensionManagementChannel('hostStatus')),
    capture: (request) => ipc.invoke(extensionManagementChannel('capture'), request),
    catalog: (request) => ipc.invoke(extensionManagementChannel('catalog'), request),
    detail: (request) => ipc.invoke(extensionManagementChannel('detail'), request),
    discoverSkills: (request) => ipc.invoke(extensionManagementChannel('discoverSkills'), request),
    previewSkill: (request) => ipc.invoke(extensionManagementChannel('previewSkill'), request),
    discardSkillCatalog: (request) =>
      ipc.invoke(extensionManagementChannel('discardSkillCatalog'), request),
    environment: (request) => ipc.invoke(extensionManagementChannel('environment'), request),
    localSkillStatus: (request) =>
      ipc.invoke(extensionManagementChannel('localSkillStatus'), request),
    prepareLocalSkill: (request) =>
      ipc.invoke(extensionManagementChannel('prepareLocalSkill'), request),
    prepare: (request) => ipc.invoke(extensionManagementChannel('prepare'), request),
    discardPlan: (request) => ipc.invoke(extensionManagementChannel('discardPlan'), request),
    apply: (request) => ipc.invoke(extensionManagementChannel('apply'), request),
    operation: (request) => ipc.invoke(extensionManagementChannel('operation'), request),
    cancel: (request) => ipc.invoke(extensionManagementChannel('cancel'), request),
  };
}
