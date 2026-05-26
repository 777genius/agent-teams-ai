import { resolveTeamProviderId } from '@main/services/runtime/providerRuntimeEnv';
import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN, wrapAgentBlock } from '@shared/constants/agentBlocks';
import { CROSS_TEAM_PREFIX_TAG } from '@shared/constants/crossTeam';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  hasUnsafeProvisionedButNotAliveRuntimeEvidence,
  isBootstrapConfirmedProvisionedButNotAliveFailure,
} from '@shared/utils/teamLaunchFailureReason';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskActivelyWorked,
  isTeamTaskDeleted,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import * as path from 'path';

import { buildActionModeProtocol } from '../actionModeInstructions';
import { normalizeLaunchFailureReasonText } from '../TeamLaunchStateEvaluator';

import { getAgentLanguageInstruction } from './TeamProvisioningAgentLanguage';

import type { RuntimeBootstrapMemberMcpLaunchConfig } from './TeamProvisioningBootstrapSpec';
import type {
  MemberSpawnStatusEntry,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
  TeamTask,
} from '@shared/types';

const { protocols } = agentTeamsControllerModule;

export interface TeamProvisioningHydrationRun {
  teamName: string;
  request: Pick<TeamCreateRequest, 'prompt'>;
  memberSpawnStatuses: ReadonlyMap<string, MemberSpawnStatusEntry>;
}

type BootstrapTranscriptSuccessSource = 'member_briefing' | 'assistant_text';

interface CanonicalSendMessageExample {
  to: string;
  summary: string;
  message: string;
}

const SEND_MESSAGE_CANONICAL_FIELDS = ['to', 'summary', 'message'] as const;
const SEND_MESSAGE_FORBIDDEN_ALIAS_FIELDS = ['recipient', 'content'] as const;

function isUnsafeProvisionedButNotAliveStatus(status: MemberSpawnStatusEntry | undefined) {
  return (
    isBootstrapConfirmedProvisionedButNotAliveFailure(status) &&
    hasUnsafeProvisionedButNotAliveRuntimeEvidence(status)
  );
}

function isSafelyHealedProvisionedButNotAliveStatus(status: MemberSpawnStatusEntry | undefined) {
  return (
    isBootstrapConfirmedProvisionedButNotAliveFailure(status) &&
    !isUnsafeProvisionedButNotAliveStatus(status)
  );
}

function formatFailedLaunchStatus(status: MemberSpawnStatusEntry): string {
  return `failed to start${status.hardFailureReason ? ` - ${status.hardFailureReason}` : status.error ? ` - ${status.error}` : ''}`;
}

function buildTeammateLaunchStatusLabel(status: MemberSpawnStatusEntry | undefined): string {
  if (!status) {
    return 'runtime state unclear';
  }
  if (
    status.launchState === 'failed_to_start' &&
    !isSafelyHealedProvisionedButNotAliveStatus(status)
  ) {
    return formatFailedLaunchStatus(status);
  }
  if (
    status.launchState === 'confirmed_alive' ||
    isSafelyHealedProvisionedButNotAliveStatus(status)
  ) {
    return 'bootstrap confirmed';
  }
  if (status.launchState === 'runtime_pending_permission') {
    return status.runtimeAlive
      ? 'runtime online and waiting for permission approval'
      : 'waiting for permission approval';
  }
  if (status.runtimeAlive) {
    return 'runtime online and ready for instructions';
  }
  if (status.launchState === 'runtime_pending_bootstrap') {
    return 'spawn accepted, runtime not confirmed yet';
  }
  if (status.status === 'spawning') {
    return 'spawn in progress';
  }
  return 'runtime state unclear';
}

export function buildCanonicalSendMessageExample(example: CanonicalSendMessageExample): string {
  return `{ ${SEND_MESSAGE_CANONICAL_FIELDS.map((field) => `${field}: "${example[field]}"`).join(', ')} }`;
}

export function getCanonicalSendMessageFieldRule(): string {
  return `CRITICAL: The SendMessage tool input must use the actual tool field names \`${SEND_MESSAGE_CANONICAL_FIELDS.join('`, `')}\`. Never invent alternate keys like \`${SEND_MESSAGE_FORBIDDEN_ALIAS_FIELDS.join('` or `')}\`. Optional supported fields may be added only when the workflow explicitly asks for them (for example \`taskRefs\`).`;
}

export function getCanonicalSendMessageToolRule(to: string): string {
  return `Use the SendMessage tool with to="${to}".`;
}

export function getVisibleTaskReferenceFormattingRule(): string {
  return [
    'Task reference formatting (CRITICAL): In visible message/comment text, write task refs as plain #<short-id> text, e.g. #abcd1234.',
    'Never wrap task refs or Markdown task links in backticks/code spans, because code spans are not linkified in Messages.',
    'Do NOT manually write [#abcd1234](task://...) in visible text.',
    'When a message tool supports taskRefs, include structured taskRefs metadata and let the app linkify the visible #abcd1234 text.',
  ].join('\n');
}

/** @deprecated Use wrapAgentBlock from @shared/constants/agentBlocks instead. */
const wrapInAgentBlock = wrapAgentBlock;

function indentMultiline(text: string, indent: string): string {
  return text
    .split(/\r?\n/g)
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function formatWorkflowBlock(workflow: string, indent: string): string {
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

export function buildTeammateAgentBlockReminder(): string {
  return [
    `Hidden internal instructions rule (IMPORTANT):`,
    `- If you send internal operational instructions to another agent/teammate that the human user must NOT see in the UI, wrap ONLY that hidden part in:`,
    `  ${AGENT_BLOCK_OPEN}`,
    `  ... hidden instructions only ...`,
    `  ${AGENT_BLOCK_CLOSE}`,
    `- Keep normal human-readable coordination outside the block.`,
    `- NEVER use agent-only blocks in messages to "user".`,
  ].join('\n');
}

export function extractHeartbeatTimestamp(text: string, fallback?: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return fallback?.trim() || undefined;
  try {
    const parsed = JSON.parse(trimmed) as { timestamp?: unknown };
    if (typeof parsed.timestamp === 'string' && parsed.timestamp.trim().length > 0) {
      return parsed.timestamp.trim();
    }
  } catch {
    // Best-effort only. Non-JSON teammate messages still use the inbox timestamp fallback.
  }
  return fallback?.trim() || undefined;
}

export function extractBootstrapFailureReason(text: string): string | null {
  const trimmed = normalizeLaunchFailureReasonText(text) ?? text.trim();
  if (!trimmed) return null;
  if (isBootstrapInstructionPrompt(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  const looksLikeBootstrapFailure =
    lower.includes('bootstrap failed') ||
    lower.includes('bootstrap failure') ||
    lower.includes('bootstrap error') ||
    lower.includes('bootstrap не удался') ||
    lower.includes('сбой bootstrap') ||
    ((lower.includes('member') || lower.includes('член')) && lower.includes('not found')) ||
    (lower.includes('не найден') &&
      (lower.includes('член') || lower.includes('member') || lower.includes('inbox'))) ||
    lower.includes('member_briefing tool is not available') ||
    lower.includes('member_briefing tool not found') ||
    lower.includes('lead_briefing tool is not available') ||
    lower.includes('lead_briefing tool not found') ||
    lower.includes('no such tool available: mcp__agent_teams__member_briefing') ||
    lower.includes('no such tool available: mcp__agent_teams__lead_briefing') ||
    lower.includes('agent calls that include team_name must also include name') ||
    (lower.includes('member_briefing') &&
      (lower.includes('not available') ||
        lower.includes('not found') ||
        lower.includes('lookup failure') ||
        lower.includes('validation error') ||
        lower.includes('api error') ||
        lower.includes('empty content') ||
        lower.includes('unspecified error'))) ||
    (lower.includes('lead_briefing') &&
      (lower.includes('not available') ||
        lower.includes('not found') ||
        lower.includes('lookup failure') ||
        lower.includes('validation error') ||
        lower.includes('api error') ||
        lower.includes('empty content') ||
        lower.includes('unspecified error'))) ||
    lower.includes('model is not supported') ||
    lower.includes('model is not available') ||
    lower.includes('model not available') ||
    lower.includes('model unavailable') ||
    lower.includes('model not found') ||
    lower.includes('unknown model') ||
    lower.includes('invalid model') ||
    lower.includes('unsupported model') ||
    lower.includes('not supported when using codex with a chatgpt account') ||
    lower.includes('please check the provided tool list');
  if (!looksLikeBootstrapFailure) return null;
  return trimmed.slice(0, 280);
}

export function isBootstrapInstructionPrompt(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized.startsWith('you are bootstrapping into team ')) {
    return false;
  }
  return (
    normalized.includes('your first action is to call the mcp tool') &&
    (normalized.includes('member_briefing') || normalized.includes('lead_briefing'))
  );
}

export function isBootstrapTranscriptSuccessText(
  text: string,
  teamName: string,
  memberName: string
): boolean {
  return getBootstrapTranscriptSuccessSource(text, teamName, memberName) !== null;
}

export function getBootstrapTranscriptSuccessSource(
  text: string,
  teamName: string,
  memberName: string
): BootstrapTranscriptSuccessSource | null {
  const normalizedText = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedText) {
    return null;
  }

  const normalizedTeamName = teamName.trim().toLowerCase();
  const normalizedMemberName = memberName.trim().toLowerCase();
  if (!normalizedTeamName || !normalizedMemberName) {
    return null;
  }

  if (
    normalizedText.startsWith(
      `member briefing for ${normalizedMemberName} on team "${normalizedTeamName}" (${normalizedTeamName}).`
    ) ||
    normalizedText.startsWith(
      `member briefing for ${normalizedMemberName} on team '${normalizedTeamName}' (${normalizedTeamName}).`
    )
  ) {
    return 'member_briefing';
  }

  return normalizedText.includes(`bootstrap выполнен для \`${normalizedMemberName}\``) &&
    normalizedText.includes(`команде \`${normalizedTeamName}\``)
    ? 'assistant_text'
    : null;
}

export function isBootstrapTranscriptContextText(
  text: string,
  teamName: string,
  memberName: string
): boolean {
  const normalizedText = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedTeamName = teamName.trim().toLowerCase();
  const normalizedMemberName = memberName.trim().toLowerCase();
  if (!normalizedText || !normalizedTeamName || !normalizedMemberName) {
    return false;
  }
  if (
    !normalizedText.includes(normalizedTeamName) ||
    !normalizedText.includes(normalizedMemberName)
  ) {
    return false;
  }
  return (
    normalizedText.includes('bootstrap') ||
    normalizedText.includes('bootstrapping') ||
    normalizedText.includes('member briefing') ||
    normalizedText.includes('task briefing')
  );
}

export function extractTranscriptTextContent(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { type?: unknown; text?: unknown; content?: unknown };
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
      parts.push(record.text.trim());
      continue;
    }
    parts.push(...extractTranscriptTextContent(record.content));
  }
  return parts;
}

export function extractTranscriptMessageText(record: unknown): string | null {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const normalizedRecord = record as {
    text?: unknown;
    content?: unknown;
    message?: unknown;
    toolUseResult?: unknown;
  };
  if (typeof normalizedRecord.text === 'string' && normalizedRecord.text.trim()) {
    return normalizedRecord.text.trim();
  }
  const fromContent = extractTranscriptTextContent(normalizedRecord.content);
  if (fromContent.length > 0) {
    return fromContent.join('\n');
  }
  const fromToolUseResult = extractTranscriptTextContent(normalizedRecord.toolUseResult);
  if (fromToolUseResult.length > 0) {
    return fromToolUseResult.join('\n');
  }
  if (normalizedRecord.message) {
    return extractTranscriptMessageText(normalizedRecord.message);
  }
  return null;
}

export function normalizeMemberDiagnosticText(memberName: string, text: string): string {
  return `${memberName}: ${text.trim()}`;
}

export function shouldUseGeminiStagedLaunch(providerId: TeamProviderId | undefined): boolean {
  return resolveTeamProviderId(providerId) === 'gemini';
}

export function buildGeminiMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  displayName: string,
  teamName: string,
  leadName: string
): string {
  const role = member.role?.trim() || 'team member';
  const providerLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `\nProvider override: ${member.providerId}.`
      : '';
  const modelLine = member.model?.trim() ? `\nModel override: ${member.model.trim()}.` : '';
  const effortLine = member.effort ? `\nEffort override: ${member.effort}.` : '';
  const workflowBlock = member.workflow?.trim() ? `\nWorkflow:\n${member.workflow.trim()}` : '';

  return `You are ${member.name}, a ${role} on team "${displayName}" (${teamName}).${providerLine}${modelLine}${effortLine}${workflowBlock}

${getAgentLanguageInstruction()}
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "${teamName}", memberName: "${member.name}" }
Call member_briefing directly. Do NOT use Agent, any subagent, or any delegated helper for this step.
If tool search says agent-teams is still connecting, wait briefly and retry tool search at most once.
If member_briefing is still unavailable after that one retry, SendMessage "${leadName}" exactly one short natural-language sentence with the exact error text, then stop this turn and wait. Do NOT send only "bootstrap failed".
Do NOT keep searching for member_briefing, check tasks, or send repeated status/idle messages after reporting the bootstrap failure.
${getCanonicalSendMessageFieldRule()}
${getVisibleTaskReferenceFormattingRule()}
Correct example:
${buildCanonicalSendMessageExample({ to: leadName, summary: 'bootstrap error', message: 'exact error text' })}
After member_briefing succeeds, stay silent until you have a real blocker, question, or task result. Do NOT send raw tool output, JSON, dict/object dumps, or internal state payloads.
- Review flow rule: review happens on the SAME work task. If task #X needs review and a reviewer exists or has been named, the owner completes #X and sends #X through review_request, and the reviewer handles review_start then review_approve/review_request_changes on #X. If no reviewer exists, leave #X completed. Do NOT create a separate "review task".`;
}

export function buildGeminiReconnectMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  teamName: string,
  leadName: string
): string {
  const role = member.role?.trim() || 'team member';
  const providerLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `\nProvider override: ${member.providerId}.`
      : '';
  const modelLine = member.model?.trim() ? `\nModel override: ${member.model.trim()}.` : '';
  const effortLine = member.effort ? `\nEffort override: ${member.effort}.` : '';
  const workflowBlock = member.workflow?.trim() ? `\nWorkflow:\n${member.workflow.trim()}` : '';

  return `You are ${member.name}, a ${role} on team "${teamName}" (${teamName}).${providerLine}${modelLine}${effortLine}${workflowBlock}

${getAgentLanguageInstruction()}
The team has just been reconnected after a restart.
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "${teamName}", memberName: "${member.name}" }
Call member_briefing directly. Do NOT use Agent, any subagent, or any delegated helper for this step.
If tool search says agent-teams is still connecting, wait briefly and retry tool search at most once.
If member_briefing is still unavailable after that one retry, SendMessage "${leadName}" exactly one short natural-language sentence with the exact error text, then stop this turn and wait. Do NOT send only "bootstrap failed".
Do NOT keep searching for member_briefing, check tasks, or send repeated status/idle messages after reporting the bootstrap failure.
${getCanonicalSendMessageFieldRule()}
${getVisibleTaskReferenceFormattingRule()}
Correct example:
${buildCanonicalSendMessageExample({ to: leadName, summary: 'bootstrap error', message: 'exact error text' })}
After member_briefing succeeds, stay silent unless you have a real blocker, question, or task result. Do NOT send raw tool output, JSON, dict/object dumps, or internal state payloads.
- Review flow rule: review happens on the SAME work task. If task #X needs review and a reviewer exists or has been named, the owner completes #X and sends #X through review_request, and the reviewer handles review_start then review_approve/review_request_changes on #X. If no reviewer exists, leave #X completed. Do NOT create a separate "review task".`;
}

export function buildMemberReviewFlowReminder(): string {
  return [
    '- Review flow rule: review is a state transition on the SAME work task, not a separate task.',
    '- If your task #X needs review and a reviewer exists or has been named, finish the work on #X, call task_complete on #X, then use review_request on #X for that reviewer. If no reviewer exists, leave #X completed. Do NOT create a separate "review task".',
    '- If you are the reviewer for task #X, call review_start on #X first, then review_approve or review_request_changes on #X itself.',
    '- If review requests changes, resume/fix the SAME task #X, then task_complete #X and send #X back through review_request when ready.',
  ].join('\n');
}

export function buildMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  displayName: string,
  teamName: string,
  leadName: string,
  options?: { restart?: boolean }
): string {
  const role = member.role?.trim() || 'team member';
  const providerLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `\nProvider override for this teammate: ${member.providerId}.`
      : '';
  const modelLine = member.model?.trim()
    ? `\nModel override for this teammate: ${member.model.trim()}.`
    : '';
  const effortLine = member.effort ? `\nEffort override for this teammate: ${member.effort}.` : '';
  const workflowBlock = member.workflow?.trim()
    ? `\n\nYour workflow and how you should behave:${formatWorkflowBlock(member.workflow, '')}`
    : '';
  const restartContext = options?.restart
    ? '\n\nThe team has already been reconnected and you are being re-attached as a persistent teammate.\nThis is a teammate restart. Repeat bootstrap exactly once, then wait for normal work instructions.'
    : '';
  const actionModeProtocol = protocols.buildActionModeProtocolText(
    protocols.MEMBER_DELEGATE_DESCRIPTION
  );
  return `You are ${member.name}, a ${role} on team "${displayName}" (${teamName}).${providerLine}${modelLine}${effortLine}${workflowBlock}${restartContext}

${getAgentLanguageInstruction()}
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "${teamName}", memberName: "${member.name}" }
Call member_briefing directly as your own MCP tool call. Do NOT use the Agent tool, any subagent, or any delegated helper for this step.
member_briefing is expected to be available in your initial MCP tool list. If it is missing or unavailable, treat that as a real bootstrap error and report the exact error text to your team lead.
Do NOT start work, claim tasks, or improvise workflow/task/process rules before member_briefing succeeds.
If tool search says agent-teams is still connecting, wait briefly and retry tool search at most once.
If member_briefing is still unavailable after that one retry, send exactly one short natural-language message to your team lead "${leadName}" that includes the exact failure reason (for example the API error, validation error, or lookup failure), then stop this turn and wait. Do NOT send only "bootstrap failed".
Do NOT keep searching for member_briefing, check tasks, or send repeated status/idle messages after reporting the bootstrap failure.
IMPORTANT: When sending messages to the team lead, always use the exact name "${leadName}" in the \`to\` field of SendMessage. Never abbreviate or shorten it (e.g. do NOT use "lead" instead of "team-lead").
${getCanonicalSendMessageFieldRule()}
${getVisibleTaskReferenceFormattingRule()}
Correct example:
${buildCanonicalSendMessageExample({ to: leadName, summary: 'short update', message: 'your message' })}
After member_briefing succeeds:
- Do NOT send a "ready", "online", "status accepted", or other acknowledgement-only message just to confirm you started successfully.
- If bootstrap succeeded and you have no task yet, stay silent and wait for task assignments.
- If bootstrap succeeded and you have no task, produce ZERO assistant text for that turn and end it immediately after the successful tool result.
- Do NOT ask the user or the lead to send you a task ID, task description, or "next task" right after bootstrap.
- Only SendMessage the lead after bootstrap when there is a real blocker, a failed bootstrap, an explicit question, an urgent coordination need, or a completed task result to report.
- Never send raw tool output, JSON, dict/object dumps, Python-style structs, or internal state payloads to the lead or the user. If you need to report bootstrap/task/tool status, rewrite it as one short natural-language sentence.
- When you later receive work or reconnect after a restart, use task_briefing as your primary working queue. Use task_list only to search/browse inventory rows, not as your working queue.
- Act only on Actionable items in task_briefing. Awareness items are watch-only context unless the lead reroutes the task or you become the actionOwner.
- Use task_get when you need the full task context before starting a pending/needsFix task or when the in_progress briefing details are not enough.
- If a newly assigned task cannot be started immediately because you are still busy on another task, leave a short task comment on that waiting task right away with the reason and your best ETA, keep it in pending/TODO, and only move it to in_progress with task_start when you truly begin.
- CRITICAL: If someone comments on your task, you MUST reply on that same task via task_add_comment. Never leave a user/lead/teammate task comment unanswered, even if the reply is only a short acknowledgement or status update. Do NOT treat status changes or direct messages as a substitute for an on-task reply.
- CRITICAL: If a task gets a new comment and you are going to do additional implementation/fix/follow-up work on that same task, FIRST leave a short task comment saying what you are about to do, THEN move it to in_progress with task_start, THEN do the work, and when finished leave a short result comment and move it to done with task_complete. Never skip this comment -> reopen -> work -> comment -> done cycle.
- CRITICAL: When you finish a task, your results (findings, research report, analysis, code changes summary, or any deliverable) MUST be posted as a task comment via task_add_comment BEFORE calling task_complete. Save the comment.id from the response — you will need it in the next step. The task comment is the primary delivery channel — the user reads results on the task board. A SendMessage to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only SendMessage without a task comment, the user will never see your work.
- After task_complete, notify your team lead via SendMessage. Keep the visible message human-readable only: include the task ref as plain #<short-id> text (not a code span and not a manual task:// Markdown link), a brief summary (2-4 sentences), where the full result lives, and the next step. Do NOT paste tool-like calls such as task_get_comment { ... } into the visible message text. Instead write "Full details in task comment <first-8-chars-of-commentId>". If the SendMessage tool input exposes optional taskRefs, include taskRefs for the task you are reporting using the exact task metadata, e.g. taskRefs: [{ taskId: "<canonical-task-id>", displayId: "<short-task-ref>", teamName: "${teamName}" }]. Example visible message: "#abcd1234 done. Found 3 competitors, two lack kanban. Full details in task comment e5f6a7b8. Moving to #efgh5678."
- Review discipline:
${indentMultiline(buildMemberReviewFlowReminder(), '  ')}
- Beyond task-completion pings, direct messages to your team lead are only for urgent attention, no-task situations, or when the lead explicitly asked for a direct reply.
- If a task-scoped update is already recorded in a task comment, do NOT send a duplicate SendMessage to the lead with the same content unless you need urgent non-task attention. When skipping a message, stay silent — never output meta-commentary about skipped or already-delivered messages.
${buildTeammateAgentBlockReminder()}
${actionModeProtocol}`;
}

export function buildReconnectMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  teamName: string,
  leadName: string,
  hasTasks: boolean
): string {
  const role = member.role?.trim() || 'team member';
  const providerLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `\n     Provider override for this teammate: ${member.providerId}.`
      : '';
  const modelLine = member.model?.trim()
    ? `\n     Model override for this teammate: ${member.model.trim()}.`
    : '';
  const effortLine = member.effort
    ? `\n     Effort override for this teammate: ${member.effort}.`
    : '';
  const workflowBlock = member.workflow?.trim()
    ? `\n\nYour workflow and how you should behave:${formatWorkflowBlock(member.workflow, '     ')}`
    : '';
  const actionModeProtocol = indentMultiline(
    protocols.buildActionModeProtocolText(protocols.MEMBER_DELEGATE_DESCRIPTION),
    '     '
  );
  const providerArgLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `   - provider: "${member.providerId}"\n`
      : '';
  const modelArgLine = member.model?.trim() ? `   - model: "${member.model.trim()}"\n` : '';
  const effortArgLine = member.effort ? `   - effort: "${member.effort}"\n` : '';
  return `   For "${member.name}":
${providerArgLine}${modelArgLine}${effortArgLine}   - prompt:
     You are ${member.name}, a ${role} on team "${teamName}" (${teamName}).${providerLine}${modelLine}${effortLine}${workflowBlock}

     ${getAgentLanguageInstruction()}
     The team has been reconnected after a restart.
     ${
       hasTasks
         ? 'You may have assigned tasks in states like in_progress, needsFix, pending, review, completed, or approved from the previous session.'
         : 'You have no assigned tasks currently.'
     }
     Your FIRST action: call MCP tool member_briefing with:
     { teamName: "${teamName}", memberName: "${member.name}" }
     Call member_briefing directly as your own MCP tool call. Do NOT use the Agent tool, any subagent, or any delegated helper for this step.
     member_briefing is expected to be available in your initial MCP tool list. If it is missing or unavailable, treat that as a real bootstrap error and report the exact error text to your team lead.
     Do NOT start work, claim tasks, or improvise workflow/task/process rules before member_briefing succeeds.
     If tool search says agent-teams is still connecting, wait briefly and retry tool search at most once.
     If member_briefing is still unavailable after that one retry, send exactly one short natural-language message to your team lead "${leadName}" that includes the exact failure reason (for example the API error, validation error, or lookup failure), then stop this turn and wait. Do NOT send only "bootstrap failed".
     Do NOT keep searching for member_briefing, check tasks, or send repeated status/idle messages after reporting the bootstrap failure.
     IMPORTANT: When sending messages to the team lead, always use the exact name "${leadName}" in the \`to\` field of SendMessage. Never abbreviate or shorten it (e.g. do NOT use "lead" instead of "team-lead").
${indentMultiline(getVisibleTaskReferenceFormattingRule(), '     ')}
     ${buildTeammateAgentBlockReminder()}
${actionModeProtocol}

     After member_briefing succeeds:
     - Do NOT send a "ready", "online", "status accepted", or other acknowledgement-only message just to confirm you reconnected successfully.
     - If reconnect bootstrap succeeded and you have no immediate blocker or question, stay silent and continue with your queue.
     - If reconnect bootstrap succeeded and you have no immediate blocker, question, or task, produce ZERO assistant text for that turn and end it immediately.
     - Do NOT ask the user or the lead to send you a task ID, task description, or "next task" right after reconnect bootstrap.
     - Never send raw tool output, JSON, dict/object dumps, Python-style structs, or internal state payloads to the lead or the user. If you need to report bootstrap/task/tool status, rewrite it as one short natural-language sentence.
     - Use task_briefing as your primary working queue. Use task_list only to search/browse inventory rows, not as your working queue.
     - Act only on Actionable items in task_briefing. Awareness items are watch-only context unless the lead reroutes the task or you become the actionOwner.
     - If task_briefing shows any in_progress task, resume/finish those first. Call task_get only if you need more context than task_briefing already gave you.
     - After that, prioritize tasks marked Needs fixes after review, then normal pending tasks.
     - Before you start any needsFix or pending task, call task_get for that specific task.
     - If a newly assigned needsFix or pending task must wait because you are still finishing another task, leave a short task comment on that waiting task with the reason and your best ETA, keep it in pending/TODO (use task_set_status pending if needed), and only run task_start when you truly begin.
     - CRITICAL: If someone comments on your task, you MUST reply on that same task via task_add_comment. Never leave a user/lead/teammate task comment unanswered, even if the reply is only a short acknowledgement or status update. Do NOT treat status changes or direct messages as a substitute for an on-task reply.
     - If you are the one about to do the implementation/fixes and the owner is missing or someone else, run task_set_owner to yourself immediately before task_start.
     - Only then run task_start when you truly begin.
     - If a task gets a new comment and you are going to do additional implementation/fix/follow-up work on it, FIRST leave a short task comment saying what you are about to do, THEN run task_start, then do the work, and when finished leave a short result comment and run task_complete again. Never skip this comment -> reopen -> work -> comment -> done cycle.
     - CRITICAL: When you finish a task, your results (findings, research report, analysis, code changes summary, or any deliverable) MUST be posted as a task comment BEFORE calling task_complete. The task comment is the primary delivery channel — the user reads results on the task board. A SendMessage to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only SendMessage without a task comment, the user will never see your work.
     - After task_complete, notify your team lead via SendMessage. The task_add_comment response contains comment.id (UUID) - take its first 8 characters as the short commentId. Keep the visible message human-readable only: include the task ref as plain #<short-id> text (not a code span and not a manual task:// Markdown link), a brief summary (2-4 sentences), where the full result lives, and the next step. Do NOT paste tool-like calls such as task_get_comment { ... } into the visible message text. Instead write "Full details in task comment <shortCommentId>". If the SendMessage tool input exposes optional taskRefs, include taskRefs for the task you are reporting using the exact task metadata, e.g. taskRefs: [{ taskId: "<canonical-task-id>", displayId: "<short-task-ref>", teamName: "${teamName}" }]. Example visible message: "#abcd1234 done. Found 3 competitors, two lack kanban. Full details in task comment e5f6a7b8. Moving to #efgh5678."
     - Review discipline:
${indentMultiline(buildMemberReviewFlowReminder(), '       ')}
     - Beyond task-completion pings, direct messages to your team lead are only for urgent attention, no-task situations, or when the lead explicitly asked for a direct reply.
     - If a task-scoped update is already recorded in a task comment, do NOT send a duplicate SendMessage to the lead with the same content unless you need urgent non-task attention. When skipping a message, stay silent — never output meta-commentary about skipped or already-delivered messages.
     - If you have no tasks, wait for new assignments.`;
}

function buildAgentToolArgsSuffix(
  member: Pick<
    TeamCreateRequest['members'][number],
    'providerId' | 'model' | 'effort' | 'isolation'
  >,
  mcpLaunchConfig?: RuntimeBootstrapMemberMcpLaunchConfig | null
): string {
  const providerPart =
    member.providerId && member.providerId !== 'anthropic'
      ? `, provider="${member.providerId}"`
      : '';
  const modelPart = member.model?.trim() ? `, model="${member.model.trim()}"` : '';
  const effortPart = member.effort ? `, effort="${member.effort}"` : '';
  const isolationPart = member.isolation === 'worktree' ? ', isolation="worktree"' : '';
  const mcpConfigPart = mcpLaunchConfig?.mcpConfigPath
    ? `, mcp_config="${mcpLaunchConfig.mcpConfigPath}"`
    : '';
  const mcpSettingSourcesPart = mcpLaunchConfig?.mcpSettingSources
    ? `, mcp_setting_sources="${mcpLaunchConfig.mcpSettingSources}"`
    : '';
  const strictMcpConfigPart =
    mcpLaunchConfig?.strictMcpConfig === undefined
      ? ''
      : `, strict_mcp_config=${mcpLaunchConfig.strictMcpConfig ? 'true' : 'false'}`;
  return `${providerPart}${modelPart}${effortPart}${isolationPart}${mcpConfigPart}${mcpSettingSourcesPart}${strictMcpConfigPart}`;
}

export function buildAddMemberSpawnMessage(
  teamName: string,
  displayName: string,
  leadName: string,
  member: Pick<
    TeamCreateRequest['members'][number],
    'name' | 'role' | 'workflow' | 'providerId' | 'model' | 'effort' | 'isolation'
  >,
  mcpLaunchConfig?: RuntimeBootstrapMemberMcpLaunchConfig | null
): string {
  const roleHint =
    typeof member.role === 'string' && member.role.trim()
      ? ` with role "${member.role.trim()}"`
      : '';
  const workflowHint =
    typeof member.workflow === 'string' && member.workflow.trim()
      ? ` Their workflow: ${member.workflow.trim()}`
      : '';

  const prompt = buildMemberSpawnPrompt(
    {
      name: member.name,
      ...(member.role ? { role: member.role } : {}),
      ...(member.workflow ? { workflow: member.workflow } : {}),
      ...(member.providerId ? { providerId: member.providerId } : {}),
      ...(member.model ? { model: member.model } : {}),
      ...(member.effort ? { effort: member.effort } : {}),
    },
    displayName,
    teamName,
    leadName
  );
  const agentArgs = buildAgentToolArgsSuffix(member, mcpLaunchConfig);

  return (
    `A new teammate "${member.name}"${roleHint} has been added to the team. ` +
    `Please spawn them immediately using the **Agent** tool with team_name="${teamName}", name="${member.name}", subagent_type="general-purpose"${agentArgs}, and the exact prompt below:${workflowHint}\n\n` +
    indentMultiline(prompt, '  ')
  );
}

export function buildRestartMemberSpawnMessage(
  teamName: string,
  displayName: string,
  leadName: string,
  member: Pick<
    TeamCreateRequest['members'][number],
    'name' | 'role' | 'workflow' | 'providerId' | 'model' | 'effort' | 'isolation'
  >,
  mcpLaunchConfig?: RuntimeBootstrapMemberMcpLaunchConfig | null
): string {
  const roleHint =
    typeof member.role === 'string' && member.role.trim()
      ? ` with role "${member.role.trim()}"`
      : '';
  const workflowHint =
    typeof member.workflow === 'string' && member.workflow.trim()
      ? ` Their workflow: ${member.workflow.trim()}`
      : '';

  const prompt = buildMemberSpawnPrompt(
    {
      name: member.name,
      ...(member.role ? { role: member.role } : {}),
      ...(member.workflow ? { workflow: member.workflow } : {}),
      ...(member.providerId ? { providerId: member.providerId } : {}),
      ...(member.model ? { model: member.model } : {}),
      ...(member.effort ? { effort: member.effort } : {}),
    },
    displayName,
    teamName,
    leadName
  );
  const agentArgs = buildAgentToolArgsSuffix(member, mcpLaunchConfig);

  return (
    `Teammate "${member.name}"${roleHint} was restarted from the UI. ` +
    `Please respawn them immediately using the **Agent** tool with team_name="${teamName}", name="${member.name}", subagent_type="general-purpose"${agentArgs}, and the exact prompt below. ` +
    `This is a restart of an existing persistent teammate, not a new teammate. ` +
    `If the Agent tool returns duplicate_skipped with reason bootstrap_pending, treat that as a pending restart and wait for teammate check-in. ` +
    `If it returns duplicate_skipped with reason already_running, do not report success - it means the previous runtime still appears active and the restart may not have applied.${workflowHint ? workflowHint : ''}\n\n` +
    indentMultiline(prompt, '  ')
  );
}

export function buildTeamCtlOpsInstructions(teamName: string, leadName: string): string {
  return wrapInAgentBlock(
    [
      `Internal task board tooling (MCP):`,
      `- Use the board-management MCP tools for tasks that must appear on the team board (assigned work, substantial work, or when the user explicitly asks to create a task).`,
      ``,
      `Execution discipline (CRITICAL — prevents misleading task boards):`,
      `- Start a task (move to in_progress) ONLY when you are actually beginning work on it.`,
      `- Complete a task ONLY when it is truly finished (and any required verification is done).`,
      `- If you assign work to a teammate who already has another in_progress task, create/keep the newly assigned task in pending/TODO. Do NOT move it to in_progress on their behalf before they actually start.`,
      `- Never bulk-move many tasks at the end of a session — update status incrementally as you work.`,
      `- Record meaningful progress, decisions, and blockers as task comments so context is preserved on the board.`,
      `- CRITICAL: Task results (findings, reports, analysis, code changes) MUST be posted as task comments — the user reads results on the task board. Direct messages alone are not visible on the board and the user will miss them.`,
      ``,
      `Parallelization guideline (IMPORTANT):`,
      `- If a task is genuinely parallelizable, split it into multiple smaller tasks owned by different members.`,
      `  - Prefer splitting by independent deliverables (e.g. frontend/backend, API/UI, parsing/rendering, tests/docs) rather than arbitrary slices.`,
      `  - Use blockedBy only when one piece truly cannot start without another; otherwise link with related.`,
      `  - Do NOT split when work is inherently sequential, requires one person to keep consistent context, or the overhead would exceed the benefit.`,
      `  - When splitting, make each task have a clear completion criterion and a single accountable owner.`,
      ``,
      `IMPORTANT: The board MCP supports these domains: lead, task, kanban, review, message, process. There is NO "member" domain — team members are managed by spawning teammates via the Task tool, not via the board MCP.`,
      ``,
      `Task board operations — use MCP tools directly:`,
      `- FIRST inspect the compact lead queue: lead_briefing { teamName: "${teamName}" }`,
      `  lead_briefing is the primary lead queue. Decisions about what to act on now come from lead_briefing, not from raw task_list rows.`,
      `- Get task details: task_get { teamName: "${teamName}", taskId: "<id>" }`,
      `- Get a single comment without loading full task: task_get_comment { teamName: "${teamName}", taskId: "<id>", commentId: "<commentId or prefix>" }`,
      `  When an inbox row provides structured task metadata (teamName/taskId/commentId), treat those identifiers as authoritative and use them directly. Do NOT infer alternate task ids or namespaces from visible prose.`,
      `- Browse/search compact inventory rows only: task_list { teamName: "${teamName}", owner?: "<member>", status?: "pending|in_progress|completed", reviewState?: "none|review|needsFix|approved", kanbanColumn?: "review|approved", relatedTo?: "<taskId or #displayId>", blockedBy?: "<taskId or #displayId>", limit?: <n> }`,
      `  task_list is inventory/search/drill-down only. Do NOT treat task_list as the lead's working queue.`,
      `- Create task: task_create { teamName: "${teamName}", subject: "...", description?: "...", owner?: "<actual-member-name>", createdBy?: "<your-name>", blockedBy?: ["1","2"], related?: ["3"] }`,
      `- Create task from user message (preferred when you have a MessageId from a relayed inbox message): task_create_from_message { teamName: "${teamName}", messageId: "<exact-messageId>", subject: "...", owner?: "<member>", createdBy?: "<your-name>", blockedBy?: ["1","2"], related?: ["3"] }`,
      `- Assign/reassign owner: task_set_owner { teamName: "${teamName}", taskId: "<id>", owner: "<member-name>" }`,
      `- Clear owner: task_set_owner { teamName: "${teamName}", taskId: "<id>", owner: null }`,
      `- Start task (preferred over set-status): task_start { teamName: "${teamName}", taskId: "<id>" }`,
      `- Complete task (preferred over set-status): task_complete { teamName: "${teamName}", taskId: "<id>" }`,
      `- Update status: task_set_status { teamName: "${teamName}", taskId: "<id>", status: "pending|in_progress|completed|deleted" }`,
      `- Add comment: task_add_comment { teamName: "${teamName}", taskId: "<id>", text: "...", from: "${leadName}" }`,
      `- Attach file to task: task_attach_file { teamName: "${teamName}", taskId: "<id>", filePath: "<path>", mode?: "copy|link", filename?: "<name>", mimeType?: "<type>" }`,
      `- Attach file to a specific comment:`,
      `  1) Find commentId: task_get { teamName: "${teamName}", taskId: "<id>" }`,
      `  2) Attach: task_attach_comment_file { teamName: "${teamName}", taskId: "<id>", commentId: "<commentId>", filePath: "<path>", mode?: "copy|link", filename?: "<name>", mimeType?: "<type>" }`,
      `- Create with deps (blocked work MUST be pending): task_create { teamName: "${teamName}", subject: "...", owner: "<member>", createdBy: "<your-name>", blockedBy: ["1","2"], related?: ["3"], startImmediately: false }`,
      `- Link dependency: task_link { teamName: "${teamName}", taskId: "<id>", targetId: "<targetId>", relationship: "blocked-by" }`,
      `- Link related: task_link { teamName: "${teamName}", taskId: "<id>", targetId: "<targetId>", relationship: "related" }`,
      `- Unlink: task_unlink { teamName: "${teamName}", taskId: "<id>", targetId: "<targetId>", relationship: "blocked-by" }`,
      `- Set clarification flag: task_set_clarification { teamName: "${teamName}", taskId: "<id>", value: "lead"|"user"|"clear" }`,
      ``,
      `Review operations — use MCP tools directly (text comments do NOT change kanban state):`,
      `- Request review (after task_complete): review_request { teamName: "${teamName}", taskId: "<id>", from: "${leadName}", reviewer: "<reviewer-name>" }`,
      `- Start review (reviewer signals they are beginning): review_start { teamName: "${teamName}", taskId: "<id>", from: "<reviewer-name>" }`,
      `- Approve review: review_approve { teamName: "${teamName}", taskId: "<id>", from: "<your-name>", note?: "<note>", notifyOwner: true }`,
      `  Call review_approve EXACTLY ONCE per review. Include your review feedback in the "note" field of that single call. Do NOT call it twice (once to approve, once with a note). The tool auto-creates a comment from the note.`,
      `- Request changes: review_request_changes { teamName: "${teamName}", taskId: "<id>", from: "<your-name>", comment: "<what to fix>" }`,
      `CRITICAL: Review is a state transition on the EXISTING work task. When implementation for task #X needs review, move #X through the review flow with review_request/review_start/review_approve/review_request_changes. Do NOT create a new separate task just to represent that review.`,
      `CRITICAL: Only send task #X into review when a concrete reviewer exists for #X. If no reviewer exists yet, keep #X completed until you assign/decide the reviewer. Do NOT use review_request just to park the task in REVIEW without an actual reviewer.`,
      `CRITICAL: Writing "approved" or "LGTM" as a task comment does NOT move the task on the kanban board. You MUST call the review_approve MCP tool. Without the tool call the task stays stuck in the REVIEW column.`,
      ``,
      `Background service operations — use MCP tools directly (dev servers, watchers, databases, etc.; NOT teammate-agent liveness):`,
      protocols.buildProcessProtocolText(teamName),
      ``,
      `Attachment storage modes (IMPORTANT):`,
      `- Default is copy (safe, robust).`,
      `- Use mode: "link" to try a hardlink (no duplication). It may fall back to copy unless you disable fallback.`,
      ``,
      `Dependency guidelines:`,
      `- Use blockedBy when a task cannot start until another is done.`,
      `- If you set blockedBy, create the task in pending (for example with startImmediately: false). Do NOT put blocked tasks into in_progress.`,
      `- Use related to link related work (e.g. frontend + backend) without blocking.`,
      `- Review tasks: By default, NEVER create a separate "review task". Reviews belong to the existing work task (#X) and must use the dedicated review flow on #X.`,
      `  - Correct flow: finish implementation on #X -> task_complete #X -> review_request #X -> reviewer runs review_start #X -> reviewer runs review_approve or review_request_changes on #X.`,
      `  - Only move #X into REVIEW when a real reviewer exists for #X. If nobody is reviewing it yet, keep #X completed until the reviewer is decided.`,
      `  - The REVIEW column is for the same task #X moving through review. It is NOT a signal to create another task for review.`,
      `  - Dependencies do not auto-start tasks; the owner must explicitly start it when ready.`,
      `- Avoid over-specifying. Only add dependencies when execution order matters.`,
      ``,
      `Notification policy:`,
      `- Task assignment notifications are handled by the board runtime, so do NOT send a separate SendMessage for the same assignment unless you have extra context that is not already on the task.`,
      `- Review requests are also handled by the board runtime: review_request already notifies the reviewer, so do NOT send a second manual SendMessage for the same review request unless you are adding materially new context that is not already on the task.`,
      `- When beginning a review, always call review_start first to move the task into the REVIEW column on the kanban board.`,
      `- If you receive a task-scoped system notification like "Comment on #...", reply on-task only when you have a substantive update: a decision, blocker, clarification answer, review result, or a concrete next-step change that belongs on the board.`,
      `- Do NOT post acknowledgement-only task comments such as "Принято", "Ок", "На связи", "Жду", or similar low-signal echoes. If the notification is FYI and no durable update is needed, say nothing and write nothing.`,
      `- Teammate task comments are auto-forwarded to you. When that happens, reply on-task first only if the task actually needs a durable board update. Direct messages are allowed only as an additional urgent wake-up ping or clearly non-task coordination, never as a substitute for a substantive task comment.`,
      `- When you skip sending a message because it would be a duplicate or was already delivered, produce NO text output about it. Do not write meta-commentary like "(Already relayed…)", "(No additional relay needed…)", or similar. Just silently move on.`,
      `- Ownership must reflect the person actually doing the implementation/fix work. If someone takes over execution, update the owner immediately before they start. Do NOT leave the lead/planner as owner when another member is doing the work.`,
      `- Set createdBy when creating tasks so workflow history shows who created the task.`,
      ``,
      `Clarification handling (CRITICAL — MANDATORY for correct task board state):`,
      `- When a teammate needs clarification (needsClarification: "lead"), you MUST reply via task comment first. This is the durable answer on the board.`,
      `- If you also send a SendMessage for urgency/visibility, treat it as an extra notification only — never as a substitute for the task-comment reply.`,
      `- Clarification flags are not assumed to auto-clear. After the blocker is truly resolved, clear the flag explicitly with:`,
      `  task_set_clarification { teamName: "${teamName}", taskId: "<taskId>", value: "clear" }`,
      `- If you cannot answer and the user needs to decide — ESCALATION PROTOCOL:`,
      `  1) FIRST, set the flag to "user" via MCP tool task_set_clarification (this updates the task board):`,
      `     { teamName: "${teamName}", taskId: "<taskId>", value: "user" }`,
      `  2) THEN, send a message to "user" explaining the question.`,
      `  3) THEN, reply to the teammate telling them to wait.`,
      `  IMPORTANT: Always update the task board BEFORE sending messages. Without the flag, the task board won't show that the task is blocked waiting for user input.`,
    ].join('\n')
  );
}

export function buildLeadRosterContextBlock(
  teamName: string,
  leadName: string,
  teammates: { name: string; role?: string }[]
): string | null {
  if (teammates.length === 0) return null;

  const summary = teammates
    .map((member) => (member.role ? `${member.name} (${member.role})` : member.name))
    .join(', ');

  return [
    `Current durable team context:`,
    `- Team name: ${teamName}`,
    `- You are the live team lead "${leadName}"`,
    `- Persistent teammates currently configured: ${summary}`,
    `- This team is NOT in solo mode`,
    `- If the user asks who is on the team, answer from this durable roster unless newer durable state explicitly says otherwise.`,
  ].join('\n');
}

/**
 * Builds the durable lead context — constraints, communication protocol, board MCP ops,
 * and agent block policy — that must survive context compaction.
 *
 * Used by: deterministic launch hydration and post-compact reinjection.
 */
export function buildPersistentLeadContext(opts: {
  teamName: string;
  leadName: string;
  isSolo: boolean;
  members: TeamCreateRequest['members'];
  /** When true, emit a compact roster (name + role only, no workflows). Used for post-compact reminders. */
  compact?: boolean;
}): string {
  const { teamName, leadName, isSolo, members, compact } = opts;
  const languageInstruction = getAgentLanguageInstruction();
  const agentBlockPolicy = buildAgentBlockUsagePolicy();
  const actionModeProtocol = buildActionModeProtocol();
  const teamCtlOps = buildTeamCtlOpsInstructions(teamName, leadName);

  const soloConstraint = isSolo
    ? `\n- SOLO MODE: This team CURRENTLY has ZERO teammates.` +
      `\n  - FORBIDDEN (until teammates exist): Do NOT spawn teammates via the Task tool with a team_name parameter — there are no teammates to spawn yet.` +
      `\n  - FORBIDDEN (until teammates exist): Do NOT call SendMessage to any teammate name — no teammates exist yet.` +
      `\n  - ALLOWED: You may message "user" (the human operator) via SendMessage.` +
      `\n  - ALLOWED: You may use the Agent tool for regular subagents WITHOUT team_name — these are normal Claude Code helpers, not teammates.` +
      `\n  - If teammates are added later (e.g. via UI), you may then spawn them using the Agent tool with team_name + name.` +
      `\n  - TASK BOARD FIRST (MANDATORY): Do NOT do substantial work silently or off-board.` +
      `\n    - Before you start meaningful implementation, debugging, research, review, or follow-up work, make sure there is a visible team-board task for it and that task is assigned to you.` +
      `\n    - If the user asks for new work, your first move is to create/update the relevant board task(s), then start work from those tasks.` +
      `\n    - If scope changes mid-task, update the existing task or create a follow-up task before continuing.` +
      `\n    - If you notice you already began meaningful work without a task, stop, put it on the board, then continue.` +
      `\n  - Work on tasks directly yourself. Use subagents for research and parallel work as needed, but keep the board as the source of truth.` +
      `\n  - PROGRESS REPORTING (MANDATORY): Since you have no teammates, "user" is your only communication channel.` +
      `\n    - SendMessage "user" at minimum: when you start a task (after marking it in_progress), when you complete a task, and when you hit a meaningful milestone/blocker/decision.` +
      `\n    - Avoid long silent stretches. If something is taking longer than expected, send a brief update and the next step.` +
      `\n  - TASK STATUS DISCIPLINE (MANDATORY):` +
      `\n    - Only move a task to in_progress when you are actively starting work on it.` +
      `\n    - Only move a task to completed when it is truly finished.` +
      `\n    - Never bulk-move many tasks at the end — update status incrementally as you work.` +
      `\n    - Default to working ONE task at a time (keep at most one task in_progress in solo mode), unless you explicitly need parallel background work (in that case explain why to "user").` +
      `\n    - Record meaningful progress/decisions as task comments so the task board stays accurate and high-signal.`
    : '';

  const membersBlock = compact ? buildCompactMembersRoster(members) : buildMembersPrompt(members);
  const membersFooter = membersBlock
    ? `Members:\n${membersBlock}`
    : 'Members: (none — solo team lead)';

  return `${languageInstruction}

Constraints:
- Do NOT call TeamDelete under any circumstances.
- Do NOT use TodoWrite.
- Do NOT send shutdown_request messages (SendMessage type: "shutdown_request" is FORBIDDEN).
- Do NOT shut down, terminate, or clean up the team or its members.
- Do NOT spawn or create a member named "user". "user" is a reserved system name for the human operator — it is NOT a teammate.
- Keep assistant text minimal. NEVER produce text about internal routing decisions — if you receive a notification, relay request, or message and decide no action is needed, produce ZERO text output. No "(Already relayed…)", "(No additional relay needed…)", "(Duplicate…)", or any similar meta-commentary. If there is nothing to do, say nothing.
- NEVER send duplicate messages to the same member. One SendMessage per member per topic is enough.
- NEVER use SendMessage with to="*" (broadcast). The "*" address is NOT supported — it will create a phantom participant named "*" instead of reaching all teammates. To message multiple teammates, send a separate SendMessage to each one by name.
- Keep the task board high-signal: avoid creating tasks for trivial micro-items.
- Use the team task board for assigned/substantial work.
- DELEGATION-FIRST (behavior rule for ALL future turns): When "user" gives you work, your top priority is to (a) decompose into tasks, (b) create tasks on the team board, (c) assign them to teammates, and (d) SendMessage "user" a short confirmation (task IDs + owners). Do NOT start implementing yourself unless the team is truly in SOLO MODE (no teammates).
- In a non-solo team, your default first move is delegation, NOT personal investigation. Do NOT read/search the codebase, inspect files, or do root-cause research yourself just to figure out ownership or scope before delegating.
- If the request is ambiguous or still needs technical discovery, immediately create a coarse investigation/triage task for the best-fit teammate. That teammate owns the code inspection, scope refinement, and creation of any follow-up tasks needed for execution.
- Only do lead-side research first if the human explicitly asked YOU for analysis/planning, or if there is genuinely no appropriate teammate to own the investigation.
- Built-in Agent usage rule: the built-in Agent tool is allowed only for normal Claude Code-style subagents WITHOUT team_name, and only on turns whose action mode is DO. In ASK or DELEGATE mode, treat Agent as forbidden. Never use Agent with team_name to relaunch the team or create persistent teammates from ordinary lead work.
- Do NOT use the built-in TaskCreate tool for team-board tasks. In this team runtime, create board tasks only via the MCP task tools (task_create, task_create_from_message, etc.).
- When messaging "user" (the human): write plain human language. If a task needs a status update, do it yourself via the board MCP tools; never ask the user to run a command.${soloConstraint}

${teamCtlOps}

${actionModeProtocol}

Communication protocol (CRITICAL — you are running headless, no one sees your text output):
- When you receive a <teammate-message> from a teammate and that message expects any reaction from you, your default action is to reply to THAT teammate using the SendMessage tool. Do NOT answer with plain assistant text for teammate-to-lead communication because that text is not delivered back to the teammate.
- A teammate-message expects a reaction when it asks a question, requests a decision, asks for clarification, reports a blocker, requests review/approval, asks you to relay or check something, or would otherwise change what happens next.
- If you need clarification from the human user before you can answer a teammate, SendMessage the teammate with a short clarification request or next step. Do NOT put that clarification question only into your plain assistant text output.
- Your plain text output is invisible to teammates — they are separate processes and can only read their inbox.
- Example: if you receive <teammate-message teammate_id="alice">...</teammate-message>, respond with SendMessage(${buildCanonicalSendMessageExample({ to: 'alice', summary: 'short reply', message: 'your reply' })}).
- Example: if alice asks "Сколько времени осталось?" and you need clarification, reply with SendMessage(${buildCanonicalSendMessageExample({ to: 'alice', summary: 'need clarification', message: 'Уточни, пожалуйста, до чего именно нужно время.' })}) instead of asking that question in plain assistant text.
- Do NOT reply to low-value acknowledgements or presence pings such as "ready", "online", "status accepted", "awaiting task", or "received" unless you need to give the teammate a concrete next action.
- Treat pure teammate idle/availability heartbeat notifications (for example idle_notification / "available" without task/failure state) as informational runtime noise. Do NOT message "user" or the teammate solely because someone became idle or available. If an idle notification only carries passive peer-summary context, do not send a user-facing reply just for that summary. Only react when the inbox item reflects interruption, failure, or concrete task-terminal state that requires action.
- Cross-team communication: when work needs expertise, coordination, review, or a decision from ANOTHER team, CALL the MCP tool named "cross_team_send" with teamName: "${teamName}" and a focused actionable message.
- Before sending cross-team, use MCP tool "cross_team_list_targets" with teamName: "${teamName}" to discover valid target teams.
- To review messages your team already sent to other teams, use MCP tool "cross_team_get_outbox" with teamName: "${teamName}".
- Cross-team delivery goes to the target team's lead inbox and may be relayed to that live lead automatically.
- Prefer cross-team messaging when your team is blocked by another team's scope, needs another team's domain expertise, needs a review/approval from another team, or must coordinate a shared decision.
- Prefer concise messages that state: what you need, why that team is relevant, the expected response, and any task or file references they need.
- Keep cross-team requests high-signal: one focused request per topic, with clear next action and desired outcome.
- Before sending a follow-up on the same topic, check "cross_team_get_outbox" so you do not resend the same request unnecessarily.
- If you receive a message that is clearly from another team (for example prefixed with "<${CROSS_TEAM_PREFIX_TAG} ... />"), treat it as an actionable cross-team request and respond to the originating team by CALLING the MCP tool "cross_team_send" when a reply, decision, or status update is needed.
- Cross-team requests may include a stable conversationId in their metadata. When you reply to that thread, preserve the same conversationId and pass replyToConversationId with that same value so the system can correlate the reply reliably.
- If the relay prompt shows explicit cross-team reply metadata/instructions for a message, follow that metadata exactly when calling "cross_team_send".
- NEVER put "cross_team_send" into a SendMessage recipient or message_send "to" field. "cross_team_send" is a TOOL NAME, not a teammate or inbox name.
- Correct example:
  cross_team_send({ teamName: "${teamName}", toTeam: "other-team", text: "your reply", conversationId: "<same-id>", replyToConversationId: "<same-id>" })
- Never write protocol markup yourself in message text. Do NOT include "<${CROSS_TEAM_PREFIX_TAG} ... />" or any other metadata wrapper in the visible reply body; send plain user-visible text only.
- When a cross-team request arrives, do NOT appear silent: first emit a brief plain-text status update visible in your own team's Messages/Activity (for example: "Accepted cross-team request from @other-team. Investigating and delegating now."), then do the research, task creation, or delegation work.
- For cross-team work, your canonical progress trail should be team-visible first. Use plain text updates, task comments, and task state changes so your own team can see what is happening.
- Do not wait silently on another team: if cross-team coordination is blocking progress, send the request promptly, then continue any useful local work that does not depend on that answer.
- After a meaningful cross-team exchange, update the relevant task or plan context so your team retains the decision, dependency, or answer.
- Reply to the requesting team when a concrete answer, decision, blocker, or status update is ready. Do NOT default to messaging "user" for cross-team coordination unless the human explicitly asked to be kept informed or the update is clearly human-relevant.
- Golden format for cross-team requests: include (1) brief context, (2) the concrete ask, (3) why your team needs that team specifically, (4) the expected output or decision, and (5) any deadline or blocking impact if relevant.
- Golden format for cross-team replies: answer the concrete ask first, then include the decision, recommendation, or status, and finally any important caveats, next steps, or handoff expectations.
- Do NOT use cross-team messaging when your own team can answer the question locally, when no action/decision is required, when you are only thinking out loud, or when a task update belongs on your own board instead of another team's inbox.
- If the issue is internal to your team, resolve it through your own task board and teammates first; use cross-team only for genuine inter-team dependency, expertise, approval, or coordination.
- Do NOT spam other teams, and do NOT use cross-team messaging for trivial FYIs that do not require action, coordination, or domain knowledge.

Message formatting:
- When mentioning teammates by name in messages and text output, always use @ prefix (e.g. @alice, @bob) for UI highlighting. When mentioning another team, also use @ (e.g. @signal-ops). Do NOT use @ in tool parameters (recipient, owner, etc.) — those require plain names.
${getVisibleTaskReferenceFormattingRule()}
${agentBlockPolicy}

${membersFooter}`;
}

export function buildAgentBlockUsagePolicy(): string {
  return `Agent-only formatting policy (applies to ALL messages you write):
- Humans can see teammate inbox messages and coordination text in the UI.
- Keep normal reasoning, decisions, and user-facing communication OUTSIDE agent-only blocks.
- Use agent-only blocks specifically for hidden internal instructions sent between agents/teammates that the human user must NOT see in the UI.
- Any internal operational instructions about tooling/scripts MUST be hidden inside an agent-only block, including:
  - how to use internal MCP tools, exact tool names, and argument shapes
  - review command phrases like "review_approve" / "review_request_changes"
  - internal file paths under ~/.claude/ (teams, tasks, kanban state, etc.)
  - meta coordination lines like "All teammates are online and have received their assignments via --notify."
- Use an agent-only tag block (AGENT_BLOCK_OPEN / AGENT_BLOCK_CLOSE):
  - AGENT_BLOCK_OPEN is exactly: ${AGENT_BLOCK_OPEN}
  - AGENT_BLOCK_CLOSE is exactly: ${AGENT_BLOCK_CLOSE}
  - IMPORTANT: put the opening tag and closing tag on their own lines with no indentation.
- Example (copy/paste exactly, no indentation):
${AGENT_BLOCK_OPEN}
(internal instructions: commands, script usage, paths, etc.)
${AGENT_BLOCK_CLOSE}
- Put ONLY the internal instructions inside the agent-only block.
- CRITICAL: Messages to "user" (the human) must NEVER contain agent-only blocks. Write them as plain readable text — the human sees these messages directly in the UI. Agent-only blocks are stripped before display, so a message containing ONLY an agent-only block will appear completely empty.
- CRITICAL: Messages to "user" must NEVER mention internal tooling, MCP tools, scripts, or CLI commands — not even in plain text. The user interacts through the UI, NOT the terminal. Specifically, NEVER include in user-facing messages:
  - internal MCP tool names or argument shapes
  - any node/bash commands
  - internal file paths (~/.claude/teams/, etc.)
  - instructions to run commands in terminal
  - task references without a leading # (for example write #abcd1234, not abcd1234)
  Instead, describe the action in human-friendly language (e.g. "Task #6 is complete." instead of showing a command to mark it complete). If you need to update task status, do it YOURSELF — never ask the user to run a command.
- CRITICAL: When processing relayed inbox messages, follow the relay prompt's reply visibility. Some relay turns record plain text only as internal lead activity. User-visible replies must be explicit when the relay prompt says the batch is internal. Do NOT wrap your entire response in an agent-only block. If you need agent-only instructions, put them in a separate block and include concise visible text only when the relay prompt allows or requests it.`;
}

export function isTaskBoardSnapshotWorkCandidate(task: TeamTask): boolean {
  if (!task.id || task.id.startsWith('_internal') || isTeamTaskDeleted(task)) {
    return false;
  }

  const workflowColumn = getTeamTaskWorkflowColumn(task);
  if (workflowColumn === 'review' || workflowColumn === 'approved') {
    return false;
  }

  return (
    task.status === 'pending' ||
    isTeamTaskNeedsFixActionable(task) ||
    isTeamTaskActivelyWorked(task)
  );
}

/** Build a full task board snapshot for the lead. */
export function buildTaskBoardSnapshot(tasks: TeamTask[]): string {
  const active = tasks.filter(isTaskBoardSnapshotWorkCandidate);
  if (active.length === 0) return '\nNo pending tasks on the board.\n';

  const lines = active.map((t) => {
    const owner = t.owner ? ` (owner: ${t.owner})` : ' (unassigned)';
    const desc = t.description ? ` — ${t.description.slice(0, 120)}` : '';
    const stateLabel = [t.status, isTeamTaskNeedsFixActionable(t) ? 'needsFix' : null]
      .filter(Boolean)
      .join(', ');
    const deps = t.blockedBy?.length
      ? ` [blocked by: ${t.blockedBy
          .map((id) => tasks.find((candidate) => candidate.id === id))
          .filter((task): task is TeamTask => Boolean(task))
          .map((task) => formatTaskDisplayLabel(task))
          .join(', ')}]`
      : '';
    return `  - ${formatTaskDisplayLabel(t)} (taskId: ${t.id}) [${stateLabel}]${owner} ${t.subject}${deps}${desc}`;
  });
  return `\nCurrent actionable task board (pending/in_progress/needsFix):\n${lines.join('\n')}\n`;
}

export function buildDeterministicLaunchHydrationPrompt(
  request: TeamLaunchRequest,
  members: TeamCreateRequest['members'],
  tasks: TeamTask[],
  isResume: boolean
): string {
  const leadName =
    members.find((member) => member.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
  const isSolo = members.length === 0;
  const projectName = path.basename(request.cwd);
  const startLabel = isResume ? 'Team Start (resume)' : 'Team Start';
  const startupLabel = isResume ? 'resume/bootstrap' : 'launch/bootstrap';
  const headerModeLabel = isResume ? 'Deterministic resume' : 'Deterministic launch';
  const userPromptBlock = request.prompt?.trim()
    ? `\nOriginal user instructions to apply after ${isResume ? 'resume' : 'startup'} is stable:\n${request.prompt.trim()}\n`
    : '';
  const hasOriginalUserPrompt = Boolean(request.prompt?.trim());
  const taskBoardSnapshot = buildTaskBoardSnapshot(tasks);
  const persistentContext = buildPersistentLeadContext({
    teamName: request.teamName,
    leadName,
    isSolo,
    members,
  });
  const nextSteps = isSolo
    ? `This ${startupLabel} step has already been completed deterministically by the runtime.
Do NOT call TeamCreate.
Do NOT use Agent to spawn or restore teammates.
Do NOT start implementation in this turn.
Use this turn only to review the current board snapshot and confirm operational readiness.
${
  hasOriginalUserPrompt
    ? 'Do NOT create or update any new task in this turn - wait for the next normal operating turn before translating those instructions into board work.'
    : 'Do NOT create, assign, or delegate any new task in this turn. If the board is empty, stay silent and wait for a fresh user instruction.'
}`
    : `This ${startupLabel} step has already been completed deterministically by the runtime.
Do NOT call TeamCreate.
Do NOT use Agent to spawn or restore teammates.
Do NOT repeat the launch summary.
Use this turn only to review the current board snapshot and teammate readiness.
${
  hasOriginalUserPrompt
    ? 'Do NOT create or assign any new task in this turn - wait for the next normal operating turn before translating those instructions into board work.'
    : 'Do NOT create, assign, or delegate any new task in this turn. If the board is empty, stay silent and wait for a fresh user instruction.'
}
Treat teammates whose bootstrap is still pending as not-yet-available for blocking assignments.`;

  return `${startLabel} [${headerModeLabel} | Team: "${request.teamName}" | Project: "${projectName}" | Lead: "${leadName}"]

You are running headless in a non-interactive CLI session. Do not ask questions.
You are "${leadName}", the team lead.
${getAgentLanguageInstruction()}${userPromptBlock}

${nextSteps}

${taskBoardSnapshot}
${persistentContext}

Reply with one concise user-facing team status line. Mention whether there is actionable board work and whether any teammate is still bootstrap-pending. Only report board readiness and teammate availability. Do not start work, create tasks, or delegate in this turn.`;
}

export function buildGeminiPostLaunchHydrationPrompt(
  run: TeamProvisioningHydrationRun,
  leadName: string,
  members: TeamCreateRequest['members'],
  tasks: TeamTask[]
): string {
  const isSolo = members.length === 0;
  const userPromptBlock = run.request.prompt?.trim()
    ? `\nOriginal user instructions to apply now:\n${run.request.prompt.trim()}\n`
    : '';
  const hasOriginalUserPrompt = Boolean(run.request.prompt?.trim());
  const taskBoardSnapshot = buildTaskBoardSnapshot(tasks);
  const teammateBootstrapSnapshot = members.length
    ? `Current teammate launch status:\n${members
        .map((member) => {
          const status = run.memberSpawnStatuses.get(member.name);
          const label = buildTeammateLaunchStatusLabel(status);
          return `- @${member.name}: ${label}`;
        })
        .join('\n')}\n`
    : '';
  const persistentContext = buildPersistentLeadContext({
    teamName: run.teamName,
    leadName,
    isSolo,
    members,
  });
  const nextStepInstruction = isSolo
    ? hasOriginalUserPrompt
      ? 'From this point on, use the full operating rules below for all future turns. Do NOT create or update any new task in this turn - wait for the next normal operating turn before translating those instructions into board work.'
      : 'From this point on, use the full operating rules below for all future turns. Do NOT create, assign, or delegate any new task in this turn. If the board is empty, stay silent and wait for a fresh user instruction.'
    : hasOriginalUserPrompt
      ? 'From this point on, use the full team operating rules below for all future turns. Do NOT create or assign any new task in this turn - wait for the next normal operating turn before translating those instructions into board work. Do NOT assume bootstrap-pending or failed teammates are ready; only treat teammates with confirmed bootstrap as immediately available for blocking assignments.'
      : 'From this point on, use the full team operating rules below for all future turns. Do NOT create, assign, or delegate any new task in this turn. If the board is empty, stay silent and wait for a fresh user instruction. Do NOT assume bootstrap-pending or failed teammates are ready; only treat teammates with confirmed bootstrap as immediately available for blocking assignments.';

  return `Gemini launch phase 2 - team readiness check for team "${run.teamName}".

The first launch/reconnect turn has already completed.
Do NOT call TeamCreate again.
Do NOT respawn teammates unless you are explicitly retrying a teammate that truly failed to start.
Do NOT repeat the previous launch summary.
You are "${leadName}", the team lead.
${getAgentLanguageInstruction()}${userPromptBlock}

${nextStepInstruction}

${teammateBootstrapSnapshot}${taskBoardSnapshot}
${persistentContext}

This is a readiness-check turn only. Do not re-run launch. Reply with one concise user-facing team status line about board readiness and teammate availability. Only report board readiness and teammate availability. Do not start work, create tasks, or delegate in this turn.`;
}
