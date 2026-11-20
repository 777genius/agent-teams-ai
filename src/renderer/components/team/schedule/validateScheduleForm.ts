import { getValidScheduleNextRuns } from '@shared/utils/scheduleTiming';
import { validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';

import type { TeamSummary } from '@shared/types';

interface ScheduleFormValidation {
  isSchedule: boolean;
  usesSavedTeamRuntime: boolean;
  mode: 'legacy' | 'agent' | 'team';
  targetMember: string;
  team?: Pick<TeamSummary, 'members' | 'leadName'>;
  teamName: string;
  prompt: string;
  cronExpression: string;
  timezone: string;
  cwd: string;
  selectedProjectPathDeleted: boolean;
  isCustomCwd: boolean;
  customFolderBlocksSubmit: boolean;
  worktreeGitBlockingMessage: string | null | undefined;
  rosterUnavailable: string;
  recipientUnavailable: string;
}

/** Validate recipient identity before unrelated one-shot filesystem errors. */
export function validateScheduleForm(input: ScheduleFormValidation): string[] {
  const errors: string[] = [];
  const target = input.targetMember.trim();
  if (input.isSchedule && input.mode === 'agent' && target) {
    if (!input.team) {
      errors.push(input.rosterUnavailable);
    } else {
      const leadName = input.team.leadName?.trim() || 'team-lead';
      if (
        target.toLowerCase() !== leadName.toLowerCase() &&
        !input.team.members?.some(
          (member) => member.name.trim() === target && !validateTeamMemberNameFormat(member.name)
        )
      ) {
        errors.push(input.recipientUnavailable);
      }
    }
  }

  if (!input.usesSavedTeamRuntime) {
    if (input.selectedProjectPathDeleted) {
      errors.push('Project folder no longer exists');
    } else if (!input.cwd) {
      errors.push('Working directory is required');
    } else if (input.isCustomCwd && input.customFolderBlocksSubmit) {
      errors.push('Project folder is not available');
    }
    if (input.worktreeGitBlockingMessage) errors.push(input.worktreeGitBlockingMessage);
  }
  if (input.isSchedule) {
    if (!input.teamName) errors.push('Team is required');
    if (!input.prompt.trim()) errors.push('Prompt is required');
    try {
      getValidScheduleNextRuns(input.cronExpression, input.timezone);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Invalid schedule timing');
    }
  }
  return errors;
}

export interface ScheduleProjectScope {
  projectPath?: string;
}

interface DialogProjectProps {
  mode: string;
  /** Where the dialog was opened from: set only by the screen of a per-project team. */
  projectScope?: ScheduleProjectScope;
  defaultProjectPath?: string;
}

/**
 * A team with separate history per project: its schedule names its own project, and the saved
 * team path (the project the team was created in) is only a default. The scope follows the team
 * (and the screen that opened the dialog), never only one of them, so every entry point gets it.
 */
export function scheduleScope(
  props: DialogProjectProps,
  team?: Pick<TeamSummary, 'projectContextMode' | 'projectPath'>
): { projectScope?: ScheduleProjectScope; defaultProjectPath?: string } {
  const scoped =
    props.mode === 'schedule' &&
    (props.projectScope !== undefined || team?.projectContextMode === 'per_project');
  const projectScope = scoped
    ? { projectPath: props.projectScope?.projectPath ?? team?.projectPath }
    : undefined;
  return {
    projectScope,
    defaultProjectPath: projectScope ? projectScope.projectPath : props.defaultProjectPath,
  };
}

/**
 * The folder a saved schedule is made for, decided when it is saved. The saved team is read at
 * that moment, so its mode is known even when the team list was not loaded at render time:
 * - a one-shot schedule (no saved team) uses the folder picked in the dialog;
 * - an ordinary team uses its saved folder;
 * - a per-project team never falls back to the folder it was created in: an existing schedule
 *   keeps its own project, a new one needs the project chosen in the dialog.
 */
export function scheduleCwd(
  saved: { cwd?: string; projectContextMode?: string } | null,
  schedule: { launchConfig: { cwd: string } } | null,
  effectiveCwd: string,
  projectScope?: ScheduleProjectScope
): string {
  if (!saved) return effectiveCwd;
  if (!projectScope && saved.projectContextMode !== 'per_project') return saved.cwd ?? '';
  if (schedule) return schedule.launchConfig.cwd;
  if (!projectScope) {
    throw new Error(
      'This team keeps separate history per project. ' +
        'Close this dialog, open it again and choose the project'
    );
  }
  return effectiveCwd;
}
