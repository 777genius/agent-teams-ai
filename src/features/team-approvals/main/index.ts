export type {
  TeamApprovalsFeature,
  TeamApprovalsFeatureDependencies,
  TeamApprovalsFileReader,
  TeamToolApprovalCompatibilityApi,
} from './composition/createTeamApprovalsFeature';
export { createTeamApprovalsFeature } from './composition/createTeamApprovalsFeature';
export {
  registerTeamApprovalsIpc,
  removeTeamApprovalsIpc,
  type TeamApprovalsIpcDependencies,
  type TeamApprovalsIpcLogger,
} from './composition/TeamApprovalsIpcBoundary';
