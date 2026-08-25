/**
 * Agent graph feature - browser-safe public API.
 *
 * Renderer UI remains available from `@features/agent-graph/renderer`.
 * This root entrypoint exposes layout contracts, pure policies, and a port-driven action factory.
 */

export { createTeamGraphLayoutActions } from './core/application/createTeamGraphLayoutActions';
export type {
  TeamGraphDefaultLayoutMemberInput,
  TeamGraphDefaultLayoutSeed,
} from './core/domain/teamGraphDefaultLayout';
export {
  buildOrderedVisibleTeamGraphOwnerIds,
  buildTeamGraphDefaultLayoutSeed,
} from './core/domain/teamGraphDefaultLayout';
export {
  areTeamGraphSlotAssignmentsEqual,
  getDefaultTeamGraphSlotAssignmentsForMembers,
  isTeamGraphSlotPersistenceDisabled,
  migrateStableSlotAssignmentsForMembers,
  normalizeLegacySixRowOrbitAssignments,
  normalizeTeamGraphGridOwnerOrder,
  normalizeTeamGraphSlotAssignmentsForVisibleOwners,
  pruneTeamGraphSlotAssignmentsForVisibleOwners,
  seedStableSlotAssignmentsForMembers,
} from './core/domain/teamGraphLayoutAssignments';
export type {
  TeamGraphConfigMemberSeedInput,
  TeamGraphLayoutActions,
  TeamGraphLayoutDiagnostic,
  TeamGraphLayoutSessionState,
  TeamGraphLayoutSlice,
  TeamGraphLayoutState,
  TeamGraphLayoutStatePatch,
  TeamGraphLayoutTransition,
  TeamGraphMemberSeedInput,
  TeamGraphSlotAssignments,
} from './core/domain/teamGraphLayoutState';
export {
  createInitialTeamGraphLayoutState,
  DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS,
  GRAPH_STABLE_SLOT_LAYOUT_VERSION,
} from './core/domain/teamGraphLayoutState';
export {
  assignTeamGraphOwnerSlot,
  changeTeamGraphLayoutMode,
  clearTeamGraphLayout,
  commitTeamGraphOwnerSlotDrop,
  ensureTeamGraphLayoutState,
  resetTeamGraphLayoutToDefaults,
  swapTeamGraphGridOwners,
  swapTeamGraphOwnerSlots,
} from './core/domain/teamGraphLayoutTransitions';
