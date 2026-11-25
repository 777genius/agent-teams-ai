import {
  isHostTeamRunId,
  isHostTeamSelectionKey,
  parseHostTeamSelectionKey,
} from '@features/agent-backend/contracts';
import {
  closeRetainedLegacyLaunch,
  openRetainedLegacyLaunch,
  type RetainedLegacyLaunchChoice,
} from '@features/agent-backend/renderer';
import { assertMemberSettingsRelaunchRoster } from '@features/team-provisioning/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import { resolveTeamLaunchDefaultProjectPath, resolveTeamListProjectPermissionAlias } from '../teamProjectSelection';

import type { TeamLaunchDialogMode } from './LaunchTeamDialog.types';
import type { MemberSettingsRelaunchDraft } from '@features/team-provisioning/renderer';
import type { ResolvedTeamMember, TeamMemberSnapshot } from '@shared/types';
import type { TeamsAPI } from '@shared/types/api';

type OriginalTeamData = Awaited<ReturnType<TeamsAPI['getData']>>;
interface OriginalLaunchOptions {
  mode?: TeamLaunchDialogMode;
  memberSettingsDraft?: MemberSettingsRelaunchDraft;
  baselineMembers?: ResolvedTeamMember[];
  onOriginalData?: (data: OriginalTeamData) => void;
}

export function resolveLaunchDialogMembers(
  members: readonly TeamMemberSnapshot[]
): ResolvedTeamMember[] {
  return members.map((member) => ({
    ...member,
    status: member.currentTaskId ? 'active' : 'idle',
    messageCount: 0,
    lastActiveAt: null,
  }));
}

export class StoppedTeamLaunchHold extends Error {}
class StoppedTeamLaunchCancelled extends Error {}

/** Explicit original-runtime transition, before any Launch model or preflight reads. */
async function chooseOriginalRuntime(
  teamName: string,
  alive: boolean,
  current: () => boolean,
  retain: (choice: RetainedLegacyLaunchChoice) => void,
  signal: AbortSignal | undefined,
  options: OriginalLaunchOptions
): Promise<boolean> {
  const teams = api.teams;
  const originalRun = () => {
    const state = useStore.getState();
    return (
      state.currentRuntimeRunIdByTeam?.[teamName] ??
      state.currentProvisioningRunIdByTeam?.[teamName]
    );
  };
  const runId = alive ? originalRun() : undefined;
  const assertCurrent = () => {
    if (!current()) throw new StoppedTeamLaunchHold('Team context changed. Reopen Launch.');
  };
  const validateDraft = async (data: OriginalTeamData) => {
    const draft = options.memberSettingsDraft;
    if (!draft) return;
    if (!options.baselineMembers)
      throw new StoppedTeamLaunchHold(
        'Original member settings are unavailable. Reopen member settings.'
      );
    assertMemberSettingsRelaunchRoster(teamName, data.members, options.baselineMembers, draft);
    assertCurrent();
    const saved = await teams.getSavedRequest(teamName);
    assertCurrent();
    if (
      !saved ||
      saved.teamName !== teamName ||
      saved.savedSettingsFingerprint !== draft.expectedTeamSettingsFingerprint
    )
      throw new StoppedTeamLaunchHold(
        'Team settings changed. Close Launch and reopen member settings.'
      );
  };
  const accepted = await confirm({
    title: alive ? 'Stop and use the original runtime?' : 'Use the original runtime?',
    message: alive
      ? 'Stop this team’s current run, then configure its next launch with the original runtime and connection settings.'
      : options.memberSettingsDraft
        ? 'Keep this team’s existing settings and configure this launch with its original runtime and connection settings.'
        : 'This team cannot be moved to Host yet. You can launch it with its original runtime and connection settings.',
    confirmLabel: alive
      ? 'Stop and configure original runtime'
      : 'Use original runtime for this team',
    cancelLabel: 'Close',
  });
  if (!accepted) return false;
  assertCurrent();
  if (alive || options.memberSettingsDraft) {
    let data = await teams.getData(teamName, { includeMemberBranches: false });
    assertCurrent();
    if (data.teamName !== teamName)
      throw new StoppedTeamLaunchHold('Original team changed. Reopen Launch.');
    await validateDraft(data);
    assertCurrent();
    if (alive && data.isAlive === true) {
      if (
        !runId ||
        runId.startsWith('pending:') ||
        isHostTeamRunId(runId) ||
        originalRun() !== runId
      )
        throw new StoppedTeamLaunchHold(
          'Original team run is unavailable or changed. Reopen Launch.'
        );
      const progress = await teams.getProvisioningStatus(runId);
      assertCurrent();
      if (progress.runId !== runId || progress.teamName !== teamName || originalRun() !== runId)
        throw new StoppedTeamLaunchHold('Original team run changed. Reopen Launch.');
      try {
        await teams.cancelProvisioning(runId);
      } catch {
        throw new StoppedTeamLaunchHold(
          'Original Stop outcome is unknown. Check the team before reopening Launch.'
        );
      }
      assertCurrent();
      data = await teams.getData(teamName, { includeMemberBranches: false });
      assertCurrent();
    }
    if (data.teamName !== teamName || data.isAlive !== false)
      throw new StoppedTeamLaunchHold(
        'Original team Stop is not confirmed. Check the team before reopening Launch.'
      );
    if (alive) await validateDraft(data);
    options.onOriginalData?.(data);
  }
  assertCurrent();
  const choice = await openRetainedLegacyLaunch(teamName, signal);
  if (!current()) {
    await closeRetainedLegacyLaunch(choice);
    throw new StoppedTeamLaunchHold('Team context changed. Reopen Launch.');
  }
  retain(choice);
  return true;
}
async function loadImportedDialog(teamName: string, projectPath: string) {
  try {
    const data = await api.teams.getData(teamName, { includeMemberBranches: false });
    return {
      teamName,
      mode: 'launch' as const,
      members: resolveLaunchDialogMembers(data.members ?? []),
      projectPath: data.config.projectPath ?? projectPath,
    };
  } catch {
    throw new StoppedTeamLaunchHold(
      'Imported Team configuration is unavailable. Reopen Launch to query the original import.'
    );
  }
}
/** Original list dialog hydration, including its draft fallback, with import refusal kept visible. */
export async function loadExistingTeamLaunchDialog(
  teamName: string,
  projectPath: string,
  mode: TeamLaunchDialogMode,
  signal?: AbortSignal
) {
  const epoch = captureContextScopedRequestEpoch();
  const current = () => !signal?.aborted && isContextScopedRequestEpochCurrent(epoch);
  const check = () => {
    if (!current()) throw new StoppedTeamLaunchHold('Team context changed. Reopen Launch.');
  };
  const qualify = async (target: {
    teamName: string; mode: TeamLaunchDialogMode; members: ResolvedTeamMember[];
    projectPath: string; retainedLegacyLaunch?: RetainedLegacyLaunchChoice;
  }) => {
    check();
    const hintedMode = useStore.getState().teamByName[target.teamName]?.projectContextMode;
    let saved;
    try { saved = await api.teams.getSavedRequest(target.teamName); }
    catch (error) {
      if (hintedMode === 'per_project' || isHostTeamSelectionKey(target.teamName)) throw error;
    }
    check();
    const mode = saved?.projectContextMode ?? hintedMode;
    let projectPermissionTeamName: string | null | undefined;
    if (mode === 'per_project') {
      if (!saved || saved.teamName !== target.teamName)
        throw new StoppedTeamLaunchHold('Saved team configuration unavailable. Reopen Launch.');
      target.members = saved.members.map((member) => ({ ...member, joinedAt: 0,
        currentTaskId: null, taskCount: 0, messageCount: 0, lastActiveAt: null, status: 'idle' as const }));
      try {
        const view = await api.teams.getProjectContextView(target.teamName, projectPath);
        check();
        projectPermissionTeamName = resolveTeamListProjectPermissionAlias(target.teamName, projectPath, view);
      } catch { check(); projectPermissionTeamName = null; }
    }
    return { ...target, projectPath: resolveTeamLaunchDefaultProjectPath(mode, projectPath, target.projectPath),
      projectPermissionTeamName };
  };
  try {
    let retainedLegacyLaunch: RetainedLegacyLaunchChoice | undefined;
    const retain = (choice: RetainedLegacyLaunchChoice) => {
      retainedLegacyLaunch = choice;
    };
    let data;
    try {
      data = await api.teams.getData(teamName, { includeMemberBranches: false });
      check();
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('TEAM_DRAFT'))) throw error;
      check();
      const target = await stoppedTeamLaunchSelection(teamName, false, retain, signal, { mode });
      check();
      if (target !== teamName) return await qualify(await loadImportedDialog(target, projectPath));
      return await qualify({
        teamName,
        mode,
        members: [] as ResolvedTeamMember[],
        projectPath,
        retainedLegacyLaunch,
      });
    }
    const target = await stoppedTeamLaunchSelection(teamName, data.isAlive, retain, signal, {
      mode,
      onOriginalData: (original) => {
        data = original;
      },
    });
    check();
    if (target !== teamName) return await qualify(await loadImportedDialog(target, projectPath));
    return await qualify({
      teamName,
      mode: retainedLegacyLaunch ? ('launch' as const) : mode,
      retainedLegacyLaunch,
      members: resolveLaunchDialogMembers(data.members ?? []),
      projectPath: data.config.projectPath ?? projectPath,
    });
  } catch (error) {
    if (!signal?.aborted) showStoppedTeamLaunchHold(error);
    return null;
  }
}
/** Original stopped action hands off to saved Host configuration; never dispatches Launch. */
export async function stoppedTeamLaunchSelection(
  teamName: string,
  isAlive: boolean | undefined,
  retain?: (choice: RetainedLegacyLaunchChoice) => void,
  signal?: AbortSignal,
  options: OriginalLaunchOptions = {}
): Promise<string> {
  if (isHostTeamSelectionKey(teamName) || isAlive === undefined || !api.agentBackend)
    return teamName;
  const epoch = captureContextScopedRequestEpoch();
  const current = () => !signal?.aborted && isContextScopedRequestEpochCurrent(epoch);
  let state;
  try {
    state = await api.agentBackend.getConnections();
  } catch {
    throw new StoppedTeamLaunchHold(
      'Captured Host context is unavailable. Reopen Launch to query the original import.'
    );
  }
  if (!current()) throw new StoppedTeamLaunchHold('Team context changed. Reopen Launch.');
  if (state.state === 'unconfigured') return teamName;
  if (isAlive || options.memberSettingsDraft) {
    if (!retain || (isAlive && options.mode !== 'relaunch'))
      throw new StoppedTeamLaunchHold('Team is already running. Reopen its Relaunch action.');
    if (await chooseOriginalRuntime(teamName, isAlive, current, retain, signal, options))
      return teamName;
    throw new StoppedTeamLaunchCancelled();
  }
  if (!api.agentBackend.stoppedImport)
    throw new StoppedTeamLaunchHold('Stopped Team import is unavailable in this context.');
  let result;
  try {
    result = await api.agentBackend.stoppedImport({ teamName, action: 'prepare' });
    if (
      !result.ok &&
      result.reason === 'held' &&
      result.outcome === 'not-dispatched' &&
      current()
    ) {
      const retry = await confirm({
        title: 'Stopped Team import held',
        message: 'Retry the original detached import? The legacy Team will remain unchanged.',
        confirmLabel: 'Retry original import',
        cancelLabel: 'Close',
      });
      if (retry && current())
        result = await api.agentBackend.stoppedImport({ teamName, action: 'retry' });
    }
  } catch {
    throw new StoppedTeamLaunchHold(
      'Import outcome unknown. Reopen Launch to query the original import; no launch was sent.'
    );
  }
  if (!current())
    throw new StoppedTeamLaunchHold(
      'Team context changed. Reopen Launch to recover the original import.'
    );
  if (
    !result.ok &&
    result.reason === 'native-custody-unverified' &&
    result.outcome === 'not-dispatched' &&
    retain
  ) {
    if (await chooseOriginalRuntime(teamName, false, current, retain, signal, options))
      return teamName;
  }
  if (!result.ok)
    throw new StoppedTeamLaunchHold(
      result.reason === 'native-custody-unverified'
        ? 'Legacy native ownership is not proven released. This Team cannot be imported yet.'
        : `Stopped Team import held: ${result.reason}. Reopen Launch to recover the original import.`
    );
  try {
    parseHostTeamSelectionKey(result.selection);
  } catch {
    throw new StoppedTeamLaunchHold('Imported Team selection is unavailable.');
  }
  return result.selection;
}
export function showStoppedTeamLaunchHold(error: unknown): void {
  if (error instanceof StoppedTeamLaunchCancelled) return;
  void confirm({
    title: 'Team Launch unavailable',
    message: error instanceof Error ? error.message : 'Stopped Team import is unavailable.',
    confirmLabel: 'Close',
    variant: 'danger',
  });
}
