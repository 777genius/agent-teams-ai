/**
 * Public main-process entrypoint for the custom-team-templates feature.
 *
 * Exports the composition boundary only: the use cases and their adapters are
 * constructed here for main-process callers, and nothing in this entrypoint is
 * safe for the renderer.
 *
 * Composition registers nothing itself. The IPC and HTTP input adapters are
 * exported here so the main-process startup boundary can wire them, and both
 * call the same composed facade.
 */
export { registerCustomTeamTemplatesHttp } from './adapters/input/http/registerCustomTeamTemplatesHttp';
export {
  registerCustomTeamTemplatesFileIpc,
  removeCustomTeamTemplatesFileIpc,
} from './adapters/input/ipc/registerCustomTeamTemplatesFileIpc';
export {
  registerCustomTeamTemplatesIpc,
  removeCustomTeamTemplatesIpc,
} from './adapters/input/ipc/registerCustomTeamTemplatesIpc';
export { ElectronCustomTeamTemplateFileGateway } from './adapters/output/ElectronCustomTeamTemplateFileGateway';
export type {
  CustomTeamTemplatesFeature,
  CustomTeamTemplatesFeatureDeps,
} from './composition/createCustomTeamTemplatesFeature';
export { createCustomTeamTemplatesFeature } from './composition/createCustomTeamTemplatesFeature';
export type { CustomTeamTemplateDesktopFileServiceDeps } from './services/CustomTeamTemplateDesktopFileService';
export { CustomTeamTemplateDesktopFileService } from './services/CustomTeamTemplateDesktopFileService';
