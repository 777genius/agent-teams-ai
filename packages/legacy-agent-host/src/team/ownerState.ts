import type { TeamLifecycleState } from './lifecycleContracts.js';
import type { TeamContextEpoch } from './TeamContextReminders.js';
import type { StoredTeamRuntimeCapture } from './runtimeRegistrationContracts.js';
import type { JsonValue } from '../contracts.js';
import type { TeamBinding, TeamGrant, TeamMember } from './contracts.js';
import type { StoredRosterReceipt, TeamSavedSettings } from './rosterContracts.js';

/** One Team publication; config.json is its recoverable controller projection. */
export interface OwnerState {
  schemaVersion: 1;
  binding: TeamBinding;
  members: TeamMember[];
  grants: TeamGrant[];
  ready: boolean;
  lifecycle?: TeamLifecycleState;
  contextEpochs?: TeamContextEpoch[];
  savedSettings?: TeamSavedSettings;
  runtimeCaptures?: StoredTeamRuntimeCapture[];
  rosterVersion?: number;
  removedMembers?: (TeamMember & { removedAt: string })[];
  rosterCommands?: StoredRosterReceipt[];
  rosterProjection?: { before: JsonValue; after: JsonValue };
}
