import {
  createTaskDetailReadAuthority,
  isSameTaskDetailReadScope,
  markTaskDetailTeamUnavailable,
  type TaskDetailDeletionIntent,
  type TaskDetailReadEntry,
  type TaskDetailReadHandle,
  type TaskDetailReadResult,
  type TaskDetailReadScope,
  type TaskDetailReadToken,
} from '@features/team-task-detail/core';

import { captureContextScopedRequestEpoch } from '../utils/contextScopedRequestEpoch';

import { captureTeamLocalStateEpoch } from './teamLocalStateEpoch';
import { isActiveProvisioningState } from './teamProvisioningStateRules';

import type { AppState } from '../types';
import type { TeamChangeEvent, TeamViewSnapshot } from '@shared/types';

export type { TaskDetailReadHandle, TaskDetailReadToken } from '@features/team-task-detail/core';

export const teamTaskDetailReadAuthority = createTaskDetailReadAuthority();

interface AcceptedLiveTeamSnapshotAuthority {
  scope: TaskDetailReadScope;
  token: TaskDetailReadToken | null;
  revision: number;
}

const acceptedLiveTeamSnapshotByContextAndTeam = new Map<
  string,
  AcceptedLiveTeamSnapshotAuthority
>();
// A cache value is only live authority after the current scoped snapshot accepts it.
const snapshotEligibilityTokenByContextAndTeam = new Map<
  string,
  { token: TaskDetailReadToken; error: string | null }
>();
let acceptedLiveTeamSnapshotRevision = 0;

function acceptedLiveTeamSnapshotKey(scope: Pick<TaskDetailReadScope, 'contextId' | 'teamName'>) {
  return JSON.stringify([scope.contextId, scope.teamName]);
}

function isAcceptedLiveTeamSnapshotCurrent(
  accepted: AcceptedLiveTeamSnapshotAuthority,
  scope: TaskDetailReadScope
): boolean {
  return (
    isTaskDetailReadScopeCurrent(scope, scope.contextId, scope.teamName) &&
    isSameTaskDetailReadScope(accepted.scope, scope)
  );
}

export function recordSnapshotEligibility(
  scope: TaskDetailReadScope,
  token: TaskDetailReadToken,
  snapshot?: Pick<TeamViewSnapshot, 'config'>
): void {
  if (token.physicalStartOrder <= 0) return;
  const key = acceptedLiveTeamSnapshotKey(scope);
  const current = snapshotEligibilityTokenByContextAndTeam.get(key);
  if (!current || token.physicalStartOrder >= current.token.physicalStartOrder) {
    snapshotEligibilityTokenByContextAndTeam.set(key, { token, error: null });
  }
  if (snapshot) acceptTaskDetailLiveTeamSnapshot(scope, snapshot, token);
}

export function isLatestStartedSnapshotEligibility(
  scope: TaskDetailReadScope,
  token: TaskDetailReadToken
): boolean {
  if (token.physicalStartOrder <= 0) return false;
  const current = snapshotEligibilityTokenByContextAndTeam.get(acceptedLiveTeamSnapshotKey(scope));
  return current === undefined || token.physicalStartOrder >= current.token.physicalStartOrder;
}

export function acceptTaskDetailLiveTeamSnapshot(
  scope: TaskDetailReadScope,
  snapshot: Pick<TeamViewSnapshot, 'config'>,
  token?: TaskDetailReadToken
): void {
  const key = acceptedLiveTeamSnapshotKey(scope);
  const accepted = acceptedLiveTeamSnapshotByContextAndTeam.get(key);
  if (
    accepted &&
    token &&
    accepted.token &&
    accepted.token.physicalStartOrder > token.physicalStartOrder
  ) {
    return;
  }
  if (
    !isTaskDetailReadScopeCurrent(scope, scope.contextId, scope.teamName) ||
    (token &&
      (!isTaskDetailTokenCurrent(token, scope) ||
        !isLatestStartedSnapshotEligibility(scope, token)))
  ) {
    return;
  }
  if (snapshot.config.deletedAt) {
    acceptedLiveTeamSnapshotByContextAndTeam.delete(key);
    return;
  }
  acceptedLiveTeamSnapshotByContextAndTeam.set(key, {
    scope,
    token: token ?? null,
    revision: ++acceptedLiveTeamSnapshotRevision,
  });
}

export function rejectLiveTeamSnapshot(
  scope: TaskDetailReadScope,
  token: TaskDetailReadToken,
  error: string
): void {
  if (
    !isTaskDetailReadScopeCurrent(scope, scope.contextId, scope.teamName) ||
    !isTaskDetailTokenCurrent(token, scope) ||
    !isLatestStartedSnapshotEligibility(scope, token)
  )
    return;
  const key = acceptedLiveTeamSnapshotKey(scope);
  snapshotEligibilityTokenByContextAndTeam.set(key, { token, error });
  const accepted = acceptedLiveTeamSnapshotByContextAndTeam.get(key);
  if (!accepted) return;
  if (!isSameTaskDetailReadScope(accepted.scope, scope)) return;
  if (accepted.token && token && accepted.token.physicalStartOrder > token.physicalStartOrder) {
    return;
  }
  acceptedLiveTeamSnapshotByContextAndTeam.delete(key);
}

function liveTeamSnapshotError(scope: TaskDetailReadScope): string | null {
  const current = snapshotEligibilityTokenByContextAndTeam.get(acceptedLiveTeamSnapshotKey(scope));
  return current &&
    isSameTaskDetailReadScope(current.token.scope, scope) &&
    isTaskDetailTokenCurrent(current.token, scope)
    ? current.error
    : null;
}

export function captureAcceptedTaskDetailLiveTeamSnapshotRevision(
  scope: TaskDetailReadScope
): number | null {
  const accepted = acceptedLiveTeamSnapshotByContextAndTeam.get(acceptedLiveTeamSnapshotKey(scope));
  return accepted && isAcceptedLiveTeamSnapshotCurrent(accepted, scope) ? accepted.revision : null;
}

export async function withFreshLiveTeamAuthority(
  get: () => AppState,
  scope: TaskDetailReadScope,
  refresh: () => Promise<unknown>
): Promise<boolean> {
  const revisionBefore = captureAcceptedTaskDetailLiveTeamSnapshotRevision(scope);
  try {
    await refresh();
  } catch {
    // Task state classifies the metadata failure below.
  }
  const revisionAfter = captureAcceptedTaskDetailLiveTeamSnapshotRevision(scope);
  return (
    revisionAfter !== null &&
    revisionAfter !== revisionBefore &&
    !isTaskDetailTeamUnavailable(get(), scope.teamName, scope)
  );
}

function hasAcceptedTaskDetailLiveTeamSnapshot(
  state: Pick<AppState, 'selectedTeamData' | 'selectedTeamName' | 'teamDataCacheByName'>,
  scope: TaskDetailReadScope
): boolean {
  const accepted = acceptedLiveTeamSnapshotByContextAndTeam.get(acceptedLiveTeamSnapshotKey(scope));
  if (!accepted || !isAcceptedLiveTeamSnapshotCurrent(accepted, scope)) return false;
  const snapshot =
    state.teamDataCacheByName[scope.teamName] ??
    (state.selectedTeamName === scope.teamName ? state.selectedTeamData : null);
  return Boolean(snapshot && !snapshot.config.deletedAt);
}

function isTaskDetailTeamDeleted(
  state: Pick<
    AppState,
    | 'selectedTeamData'
    | 'selectedTeamName'
    | 'teamByName'
    | 'teamDataCacheByName'
    | 'teamManagementNoticeByTeam'
  >,
  teamName: string
): boolean {
  const snapshot =
    state.teamDataCacheByName[teamName] ??
    (state.selectedTeamName === teamName ? state.selectedTeamData : null);
  if (snapshot) return Boolean(snapshot.config.deletedAt);
  if (state.teamManagementNoticeByTeam[teamName]?.kind === 'trashed') return true;
  return Boolean(state.teamByName[teamName]?.deletedAt);
}

function isTaskDetailTeamProvisioning(
  state: Pick<AppState, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): boolean {
  const runId = state.currentProvisioningRunIdByTeam?.[teamName];
  const run = runId ? state.provisioningRuns?.[runId] : null;
  return Boolean(run && isActiveProvisioningState(run.state));
}

export function markLiveTeamMetadataUnavailable(
  entry: TaskDetailReadEntry,
  state: Pick<
    AppState,
    | 'selectedTeamData'
    | 'selectedTeamName'
    | 'teamByName'
    | 'teamDataCacheByName'
    | 'teamManagementNoticeByTeam'
    | 'selectedTeamError'
    | 'currentProvisioningRunIdByTeam'
    | 'provisioningRuns'
  >,
  scope: TaskDetailReadScope
): TaskDetailReadEntry {
  const selectedError = state.selectedTeamName === scope.teamName ? state.selectedTeamError : null;
  if (isTaskDetailTeamDeleted(state, scope.teamName)) return markTaskDetailTeamUnavailable(entry);
  const error = liveTeamSnapshotError(scope) ?? selectedError;
  const unavailable = { ...entry, loading: false };
  if (error?.includes('TEAM_PROVISIONING') || isTaskDetailTeamProvisioning(state, scope.teamName))
    return { ...unavailable, phase: 'provisioning', error: null };
  return {
    ...unavailable,
    phase: 'unavailable',
    error: error || 'Live team metadata unavailable',
  };
}

export function resetTeamTaskDetailReadAuthorityForTests(): void {
  teamTaskDetailReadAuthority.resetForTests();
  acceptedLiveTeamSnapshotByContextAndTeam.clear();
  snapshotEligibilityTokenByContextAndTeam.clear();
}

export function captureTaskDetailReadScope(
  teamName: string,
  contextId: string
): TaskDetailReadScope {
  return {
    contextId,
    teamName,
    contextEpoch: captureContextScopedRequestEpoch(),
    teamStateEpoch: captureTeamLocalStateEpoch(teamName),
  };
}

export function isTaskDetailReadScopeCurrent(
  scope: TaskDetailReadScope,
  contextId: string,
  teamName: string
): boolean {
  return (
    scope.contextId === contextId &&
    scope.teamName === teamName &&
    captureContextScopedRequestEpoch() === scope.contextEpoch &&
    captureTeamLocalStateEpoch(teamName) === scope.teamStateEpoch
  );
}

export function isTaskDetailTokenCurrent(
  token: TaskDetailReadToken,
  scope: TaskDetailReadScope
): boolean {
  return teamTaskDetailReadAuthority.isTokenCurrent(token, scope);
}

export function isTaskDetailTeamUnavailable(
  state: Pick<
    AppState,
    | 'selectedTeamData'
    | 'selectedTeamName'
    | 'teamByName'
    | 'teamDataCacheByName'
    | 'teamManagementNoticeByTeam'
  >,
  teamName: string,
  scope: TaskDetailReadScope
): boolean {
  return (
    isTaskDetailTeamDeleted(state, teamName) || !hasAcceptedTaskDetailLiveTeamSnapshot(state, scope)
  );
}

export function readTeamSnapshotResource<T>(
  teamName: string,
  scope: TaskDetailReadScope,
  read: (token: TaskDetailReadToken, markPhysicalStart: () => void) => Promise<T>,
  options?: { forceNew?: boolean; mode?: 'full' | 'thin'; deferPhysicalStart?: boolean }
): TaskDetailReadHandle<T> {
  return teamTaskDetailReadAuthority.readSnapshot(teamName, scope, read, options);
}

export function readTeamTaskFullResource<T>(
  identity: { contextId: string; teamName: string; taskId: string },
  scope: TaskDetailReadScope,
  read: (token: TaskDetailReadToken) => Promise<T>
): TaskDetailReadHandle<T> {
  return teamTaskDetailReadAuthority.readFull(identity, scope, read);
}

export function invalidateTeamSnapshotResource(contextId: string, teamName: string): void {
  teamTaskDetailReadAuthority.invalidateSnapshot(teamName, contextId);
  acceptedLiveTeamSnapshotByContextAndTeam.delete(
    acceptedLiveTeamSnapshotKey({ contextId, teamName })
  );
}

export function invalidateTeamTaskFullResource(identity: {
  contextId: string;
  teamName: string;
  taskId: string;
}): void {
  teamTaskDetailReadAuthority.invalidateFull(identity);
}

export function invalidateAcceptedTaskDetailMutation(
  get: () => Pick<
    AppState,
    | 'activeContextId'
    | 'isContextSwitching'
    | 'invalidateTaskDetailSource'
    | 'setTaskDetailDeletionIntent'
  >,
  teamName: string,
  taskId: string,
  scope: Omit<TaskDetailReadScope, 'teamName'>,
  intent?: Exclude<TaskDetailDeletionIntent, null>
): void {
  const state = get();
  if (
    state.isContextSwitching ||
    !isTaskDetailReadScopeCurrent({ ...scope, teamName }, state.activeContextId, teamName)
  )
    return;
  const identity = { contextId: scope.contextId, teamName, taskId };
  if (intent && !state.setTaskDetailDeletionIntent(identity, intent, scope)) return;
  state.invalidateTaskDetailSource(identity);
}

/** Source invalidation belongs to the same task read authority as physical reads. */
export function invalidateTaskDetailForTeamChange(
  state: Pick<
    AppState,
    | 'activeContextId'
    | 'isContextSwitching'
    | 'invalidateTaskDetailTeamSource'
    | 'invalidateTaskDetailResources'
    | 'taskDetailResourcesById'
  >,
  event: TeamChangeEvent,
  staleRuntimeEvent: boolean
): void {
  if (staleRuntimeEvent || state.isContextSwitching) return;
  if (
    event.type === 'log-source-change' ||
    (event.type === 'task-log-change' && event.taskSignalKind === 'log')
  ) {
    const identities = new Map<string, { contextId: string; teamName: string; taskId: string }>();
    for (const entry of Object.values(state.taskDetailResourcesById)) {
      const identity = entry.identity;
      if (
        identity.contextId !== state.activeContextId ||
        identity.teamName !== event.teamName ||
        (event.taskId && identity.taskId !== event.taskId)
      )
        continue;
      identities.set(identity.taskId, identity);
    }
    for (const identity of identities.values()) state.invalidateTaskDetailResources(identity);
    return;
  }
  if (
    event.type !== 'task' &&
    event.type !== 'config' &&
    !(event.type === 'task-log-change' && event.taskSignalKind !== 'log')
  )
    return;
  state.invalidateTaskDetailTeamSource(state.activeContextId, event.teamName, event.taskId);
}

/** Normalize transport failures after the caller has checked its captured read scope. */
export function unwrapTaskDetailReadResult<T>(result: TaskDetailReadResult<T>): T {
  if (result.error) {
    throw result.error instanceof Error
      ? result.error
      : new Error(typeof result.error === 'string' ? result.error : 'Failed to load team data', {
          cause: result.error,
        });
  }
  if (result.value === undefined) throw new Error('Task data read returned no value');
  return result.value;
}
