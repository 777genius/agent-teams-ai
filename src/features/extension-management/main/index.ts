export { ExtensionRuntimeGate } from '../core/application/ExtensionRuntimeGate';
export { ManagementHttpCapability } from './infrastructure/ManagementHttpCapability';
export type {
  CapturedExtensionEnvironment,
  ExtensionContextResolver,
  ExtensionManagementFeature,
} from '../core/application/ports';
export { registerExtensionManagementHttp } from './adapters/input/registerExtensionManagementHttp';
export { registerExtensionManagementIpc } from './adapters/input/registerExtensionManagementIpc';
export { createAppExtensionManagement } from './composition/createAppExtensionManagement';
export { createDesktopExtensionManagement } from './composition/createDesktopExtensionManagement';
export { createElectronExtensionManagement } from './composition/createElectronExtensionManagement';
export { createExtensionManagementFeature } from './composition/createExtensionManagementFeature';
export { createReadOnlyExtensionManagement } from './composition/createReadOnlyExtensionManagement';
