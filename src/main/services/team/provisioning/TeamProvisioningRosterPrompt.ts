import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { isLeadMember, isLeadNameAlias, isReservedLeadRole } from '@shared/utils/leadDetection';
import { protocols } from 'agent-teams-controller';

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
// in the roster. A reserved lead role on a non-alias name is a spawned
// teammate, not the orchestrator, so it stays too. Only runtime-owned lead
// identity (lead agentType, the "team-lead" name, or a reserved role on a
// lead-name alias) is filtered out.
function isLeadRosterMember(member: TeamCreateRequest['members'][number]): boolean {
  if (isLeadMember(member)) return true;
  const role = member.role?.trim() ?? '';
  return role.length > 0 && isReservedLeadRole(role) && isLeadNameAlias(member.name);
}

/** Roster entries the lead may delegate to — every configured member except the lead itself. */
export function getTeammateRosterMembers(
  members: TeamCreateRequest['members']
): TeamCreateRequest['members'] {
  return members.filter((member) => !isLeadRosterMember(member));
}

export function buildLeadTeamScopeRule(teamName: string): string {
  return `- Your team is "${teamName}". Wherever a tool asks for YOUR team (Agent team_name, board/message teamName) use exactly "${teamName}". Reach other teams only via cross_team_send with toTeam.`;
}

export function buildLeadRosterIntegrityRules(
  teamName: string,
  teammates: readonly { name: string }[]
): string {
  const names = teammates.map((member) => member.name).join(', ');
  return [
    `Teammate roster rules (CRITICAL — exact names only):`,
    buildLeadTeamScopeRule(teamName),
    `- Your teammates are EXACTLY: ${names}. No other teammate exists.`,
    `- NEVER invent, guess, rename, or paraphrase teammate names (no placeholders like "alice"/"bob"). Use these exact names in task owners and SendMessage \`to\`.`,
    `- Roster teammates are launched and restarted by the app/runtime. Do NOT spawn, respawn, or restore them with the Agent tool on your own initiative - only when an app message explicitly asks you to (re)spawn a specific teammate.`,
    `- "One per teammate" / "each teammate" in instructions means exactly this roster — one item per listed name, nothing more.`,
    `- Do NOT do work meant for a teammate before that teammate is available. If a teammate has not joined or confirmed bootstrap yet, create the task, assign it to the exact roster name, and WAIT for the owner to do it — never produce their deliverable yourself.`,
  ].join('\n');
}

// Create mode has no launch-hydration turn, so this deferred first prompt is the
// lead's only source of its team scope and roster. The runtime prepends it after
// deterministic bootstrap (TeamCreate + teammate spawns) finishes: teammates
// exist (or failed) but may still be finishing their first turn.
export function buildCreateBootstrapUserPrompt(
  teamName: string,
  initialUserPrompt: string,
  members: TeamCreateRequest['members']
): string {
  const trimmedPrompt = initialUserPrompt.trim();
  const teammates = getTeammateRosterMembers(members);
  if (!trimmedPrompt) {
    return trimmedPrompt;
  }
  const roster = buildMembersPrompt(teammates.map(({ workflow: _workflow, ...member }) => member));
  return [
    wrapAgentBlock(protocols.buildChatVisualizationProtocolText()),
    ...(teammates.length > 0
      ? [
          'Team roster (authoritative — from the team configuration):',
          roster,
          '',
          buildLeadRosterIntegrityRules(teamName, teammates),
        ]
      : [buildLeadTeamScopeRule(teamName)]),
    '',
    'User instructions:',
    trimmedPrompt,
  ].join('\n');
}
