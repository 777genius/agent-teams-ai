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
    if (!input.cronExpression.trim()) errors.push('Cron expression is required');
  }
  return errors;
}
