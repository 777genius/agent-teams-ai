import { isLeadMember, isReservedLeadRole } from '@shared/utils/leadDetection';

import type { TeamCreateRequest } from '@shared/types';

export function indentMultiline(text: string, indent: string): string {
  return text
    .split(/\r?\n/g)
    .map((line) => `${indent}${line}`)
    .join('\n');
}

export function formatWorkflowBlock(workflow: string, indent: string): string {
  const trimmed = workflow.trim();
  if (trimmed.length === 0) return '';
  const body = indentMultiline(trimmed, indent);
  return `\n${indent}---BEGIN WORKFLOW---\n${body}\n${indent}---END WORKFLOW---`;
}

export function buildMembersPrompt(members: TeamCreateRequest['members']): string {
  return members
    .map((member) => {
      const rolePart = member.role?.trim() ? ` (role: ${member.role.trim()})` : '';
      const providerPart =
        member.providerId && member.providerId !== 'anthropic'
          ? ` [provider: ${member.providerId}]`
          : '';
      const modelPart = member.model?.trim() ? ` [model: ${member.model.trim()}]` : '';
      const effortPart = member.effort ? ` [effort: ${member.effort}]` : '';
      const isolationPart = member.isolation === 'worktree' ? ' [isolation: worktree]' : '';
      const workflowPart = member.workflow?.trim()
        ? `\n     Workflow/instructions:${formatWorkflowBlock(member.workflow, '       ')}`
        : '';
      return `- ${member.name}${rolePart}${providerPart}${modelPart}${effortPart}${isolationPart}${workflowPart}`;
    })
    .join('\n');
}

/** Compact roster: name + role only, no workflow details. Used for post-compact reminders. */
export function buildCompactMembersRoster(members: TeamCreateRequest['members']): string {
  return members
    .map((member) => {
      const rolePart = member.role?.trim() ? ` (${member.role.trim()})` : '';
      return `- ${member.name}${rolePart}`;
    })
    .join('\n');
}

// Canonical lead detection only — a free-form teammate role such as
// "Frontend lead" or "Tech lead" is a normal delegable teammate and must stay
// in the roster. Only the runtime-owned lead identity (lead agentType, the
// "team-lead" name, or a role reserved for the lead) is filtered out.
function isLeadRosterMember(member: TeamCreateRequest['members'][number]): boolean {
  if (isLeadMember(member)) return true;
  const role = member.role?.trim() ?? '';
  return role.length > 0 && isReservedLeadRole(role);
}

/** Roster entries the lead may delegate to — every configured member except the lead itself. */
export function getTeammateRosterMembers(
  members: TeamCreateRequest['members']
): TeamCreateRequest['members'] {
  return members.filter((member) => !isLeadRosterMember(member));
}

export function buildLeadRosterIntegrityRules(teammateNames: readonly string[]): string {
  const names = teammateNames.join(', ');
  return [
    `Teammate roster rules (CRITICAL — exact names only):`,
    `- Your teammates are EXACTLY: ${names}. No other teammate exists.`,
    `- NEVER invent, guess, rename, or paraphrase teammate names (no placeholders like "alice"/"bob"). Use these exact names in task owners, SendMessage \`to\`, and Agent spawns.`,
    `- "One per teammate" / "each teammate" in instructions means exactly this roster — one item per listed name, nothing more.`,
    `- Do NOT do work meant for a teammate before that teammate is available. If a teammate has not joined or confirmed bootstrap yet, create the task, assign it to the exact roster name, and WAIT for the owner to do it — never produce their deliverable yourself.`,
  ].join('\n');
}

// Create-mode launches deliver the deferred first user prompt before any
// teammate confirms bootstrap, so the authoritative roster must ride along
// with it — otherwise the lead has no teammate names in-context and may
// invent teammates or execute their work itself.
export function buildCreateBootstrapUserPrompt(
  initialUserPrompt: string,
  members: TeamCreateRequest['members']
): string {
  const trimmedPrompt = initialUserPrompt.trim();
  const teammates = getTeammateRosterMembers(members);
  if (!trimmedPrompt || teammates.length === 0) {
    return trimmedPrompt;
  }
  const roster = buildMembersPrompt(teammates.map(({ workflow: _workflow, ...member }) => member));
  return [
    'Team roster (authoritative — from the team configuration):',
    roster,
    '',
    buildLeadRosterIntegrityRules(teammates.map((member) => member.name)),
    '',
    'User instructions:',
    trimmedPrompt,
  ].join('\n');
}
