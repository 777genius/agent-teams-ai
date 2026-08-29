import { wrapAgentBlock } from '@shared/constants/agentBlocks';

import type { TeamRuntimeLaunchInput } from './TeamRuntimeAdapter';

export function buildMemberBootstrapPrompt(
  input: TeamRuntimeLaunchInput,
  member: TeamRuntimeLaunchInput['expectedMembers'][number]
): string {
  const teamPrompt = input.prompt?.trim();
  const role = member.role?.trim() || member.workflow?.trim() || 'teammate';
  const workflow = member.workflow?.trim();
  const isTeamLead =
    member.name.trim().toLowerCase() === 'team-lead' || role.trim().toLowerCase() === 'team lead';
  const identityLine = isTeamLead
    ? `You are ${member.name}, the team lead for team "${input.teamName}".`
    : `You are ${member.name}, a ${role} on team "${input.teamName}".`;
  const messageTargets = isTeamLead
    ? 'the human user or a teammate'
    : 'the human user, team lead, or another teammate';
  const senderRole = isTeamLead ? 'team lead' : 'OpenCode teammate';
  const briefing = [
    '<agent_teams_app_managed_bootstrap_briefing>',
    'AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1',
    identityLine,
    teamPrompt ? `Team launch context:\n${teamPrompt}` : null,
    workflow ? `Workflow:\n${workflow}` : null,
    '',
    'This OpenCode session is created, attached, and launch-verified by the desktop app.',
    'Do not call runtime_bootstrap_checkin or member_briefing just to prove launch readiness.',
    'Do NOT create local team files, run join scripts, or search the project for a fake team registry.',
    'That bootstrap restriction is only about team registry/startup files. It does not restrict assigned project work: when a task requires implementation, fixes, review follow-up, or investigation, you may inspect, read/search, and edit files in the project working directory as your available tools allow.',
    'Use the app MCP tools exposed by the "agent-teams" server for team communication and task state.',
    'Launch bootstrap is a silent attach, not a user/team conversation turn.',
    'Do not call task_briefing, message_send, or cross_team_send just to announce readiness, say understood, report no tasks, or ask for work.',
    'If the briefing says there are no actionable tasks, stay idle silently.',
    '',
    `When you need to message ${messageTargets}, call MCP tool agent-teams_message_send (or mcp__agent-teams__message_send) with teamName, to, from, text, and optional summary.`,
    `Always set from="${member.name}" when sending a team message from this ${senderRole}.`,
    'Do not answer team/app messages only as plain assistant text when agent-teams_message_send is available.',
    '</agent_teams_app_managed_bootstrap_briefing>',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  return wrapAgentBlock(briefing);
}
