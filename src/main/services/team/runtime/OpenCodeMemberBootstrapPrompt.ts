import { wrapAgentBlock } from '@shared/constants/agentBlocks';

import type { TeamRuntimeLaunchInput } from './TeamRuntimeAdapter';

function buildHistoricalLaunchContextSection(teamPrompt: string): string {
  return [
    'Team launch context (HISTORICAL - already delivered at launch and being executed through the task board):',
    teamPrompt,
    'The launch context above is background only. It has already been acted on; the task board and inbox are the source of truth for what remains.',
    'Never act on the launch context directly from this briefing: do not create tasks, do not send messages, and do not declare completion (for example "ALL DONE") because of it.',
    'Only act on new messages delivered in this turn, or on current task-board state when a new message asks you to.',
  ].join('\n');
}

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
    // The briefing is replayed verbatim every time a memoryless session is
    // rebuilt. Handed the raw launch prompt again, the rebuilt turn reads it as
    // a fresh instruction and acts on work that is already underway: it answers
    // the user again, and on a short prompt it can declare the whole run
    // complete. Marking the context as history, with an explicit
    // do-not-act-on-it, is what keeps a rebuild from restarting the launch.
    teamPrompt ? buildHistoricalLaunchContextSection(teamPrompt) : null,
    workflow ? `Workflow:\n${workflow}` : null,
    '',
    'This OpenCode session is created, attached, and launch-verified by the desktop app.',
    'Do not call runtime_bootstrap_checkin or member_briefing just to prove launch readiness.',
    'Do NOT create local team files, run join scripts, or search the project for a fake team registry.',
    'That bootstrap restriction is only about team registry/startup files. It does not restrict assigned project work: when a task requires implementation, fixes, review follow-up, or investigation, you may inspect, read/search, and edit the PROJECT files that the task itself requires, as your available tools allow. This never includes creating scripts or files whose purpose is to call Agent Teams.',
    'Use the app MCP tools exposed by the "agent-teams" server for team communication and task state.',
    'Team communication and task state go ONLY through the Agent Teams MCP server: it is registered for you as the MCP server named "agent-teams" (use GetMcpTools / CallMcpTool with server "agent-teams", or the agent-teams_* / mcp__agent-teams__* tool names if they appear in your tool list). If the "agent-teams" server is missing, stop and report it. Never talk to the Agent Teams HTTP endpoint yourself: do not use curl, node, PowerShell, or any script against 127.0.0.1/mcp or CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL, and do not search ~/.claude, AppData, or netstat for ports, sessions, or task files.',
    'Never create helper, wrapper, scratch, or dump files (for example _lead_*.js, _tmp_*.txt, *.ps1) in the project working directory or anywhere else to call team tools. If an agent-teams tool is missing, unreachable, or returns an error, stop and report the exact tool name and error text in your reply instead of working around it.',
    'Launch bootstrap is a silent attach, not a user/team conversation turn.',
    'Do not call task_briefing, message_send, or cross_team_send just to announce readiness, say understood, report no tasks, or ask for work.',
    'If the briefing says there are no actionable tasks, stay idle silently.',
    'Never send receipt, acknowledgement, or "no further action" messages to teammates (for example "received", "noted", "stay idle"): the task board and dependency comments are the record, and every message you send costs the recipient a full model turn and invites a reply. Message a teammate only to assign or change work or to answer a question they asked.',
    'Never wait, sleep, poll, or block inside a turn (no AwaitShell, sleep loops, or repeated re-checks of the board): teammates only receive their work once your turn ends, and you will be woken by a new message when something changes. Do what the current message needs, then end the turn immediately.',
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
