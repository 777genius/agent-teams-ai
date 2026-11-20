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
  /** Where the dialog was opened from: the default project of a new schedule. */
  projectScope?: ScheduleProjectScope;
  defaultProjectPath?: string;
}

/**
 * A team with separate history per project: its schedule names its own project, and the saved
 * team path (the project the team was created in) is only a default. The scope follows the team,
 * never the page the dialog was opened from, so every entry point gets it.
 */
export function scheduleScope(
  props: DialogProjectProps,
  team?: Pick<TeamSummary, 'projectContextMode' | 'projectPath'>
): { projectScope?: ScheduleProjectScope; defaultProjectPath?: string } {
  const scoped = props.mode === 'schedule' && team?.projectContextMode === 'per_project';
  const projectScope = scoped
    ? { projectPath: props.projectScope?.projectPath ?? team.projectPath }
    : undefined;
  return {
    projectScope,
    defaultProjectPath: projectScope ? projectScope.projectPath : props.defaultProjectPath,
  };
}

/** The saved team can back a schedule: a provider, and a folder unless the schedule names one. */
export function canSchedule(
  saved: { cwd?: string; providerId?: string } | null,
  projectScope?: ScheduleProjectScope
): boolean {
  return Boolean(saved?.providerId) && (Boolean(projectScope) || Boolean(saved?.cwd?.trim()));
}
