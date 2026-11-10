export { registerRecentProjectsHttp } from './adapters/input/http/registerRecentProjectsHttp';
export {
  registerRecentProjectsIpc,
  removeRecentProjectsIpc,
} from './adapters/input/ipc/registerRecentProjectsIpc';
export type { RecentProjectsFeatureFacade } from './composition/createRecentProjectsFeature';
export { createRecentProjectsFeature } from './composition/createRecentProjectsFeature';
