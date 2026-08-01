export {
  clearTeamTaskBoardAnalytics,
  recordTeamTaskBoardSnapshotTransitions,
  resetTeamTaskBoardAnalyticsForTests,
} from './composition/taskLifecycleAnalytics';
export type {
  TeamTaskArtifactAnalyticsAttachment,
  TeamTaskArtifactFile,
  TeamTaskArtifactsRendererSlice,
  TeamTaskArtifactsRendererSliceDependencies,
  TeamTaskArtifactsRendererState,
  TeamTaskArtifactsTransport,
} from './ports/TeamTaskArtifactsRendererPorts';
export type {
  TeamTaskBoardRendererSlice,
  TeamTaskBoardRendererSliceDependencies,
  TeamTaskBoardRendererStoreContext,
  TeamTaskBoardTransport,
} from './ports/TeamTaskBoardRendererPorts';
export type { TeamTaskDetailRendererPorts } from './ports/TeamTaskDetailRendererPorts';
export type { TeamTaskNotificationTransportPort } from './ports/TeamTaskNotificationPorts';
export { createTeamTaskArtifactsRendererSlice } from './slices/createTeamTaskArtifactsRendererSlice';
export { createTeamTaskBoardRendererSlice } from './slices/createTeamTaskBoardRendererSlice';
export {
  collectTaskChangeInvalidation,
  preserveKnownTaskChangePresence,
  type TaskChangeInvalidation,
} from './utils/taskChangePresenceProjectionPolicy';
