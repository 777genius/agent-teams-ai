import { parseStructuredAgentMessage } from '@renderer/utils/agentMessageFormatting';
import {
  getBootstrapAcknowledgementDisplay,
  getBootstrapPromptDisplay,
  getSanitizedInboxMessageSummary,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';
import {
  classifyIdleNotification,
  getIdleNoiseLabel,
} from '@renderer/utils/idleNotificationSemantics';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
  stripCrossTeamPrefix,
} from '@shared/constants/crossTeam';
import { isRateLimitMessage } from '@shared/utils/rateLimitDetector';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  isMemberWorkSyncNudgeMessage,
  isTaskStallRemediationMessage,
} from '@shared/utils/teamAutomationMessages';

import { encodeCacheParts } from './activityRenderCache';

import type { InboxMessage } from '@shared/types';

export type ChatAppearance = 'compact' | 'wide-chat';
export type ActivityMessagePresentationKind = 'ordinary-agent' | 'ordinary-user' | 'special';

type StructuredMessage = Record<string, unknown>;

export interface ActivityMessagePresentation {
  kind: ActivityMessagePresentationKind;
  author: string;
  route: string;
  hasRenderableBody: boolean;
}

const MAX_ACTIVITY_ITEM_CACHE_ENTRIES = 500;
const activityStructuredMessageCache = new Map<string, StructuredMessage | null>();
const activityIdleSemanticCache = new Map<string, ReturnType<typeof classifyIdleNotification>>();
const activityNoiseMessageCache = new Map<string, boolean>();
const activityStrippedTextCache = new Map<string, string | null>();

function getCachedActivityValue<T>(cache: Map<string, T>, key: string, buildValue: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;

  const value = buildValue();
  if (cache.size >= MAX_ACTIVITY_ITEM_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
  return value;
}

function getStringField(obj: StructuredMessage, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function parseStructuredAgentMessageCached(text: string): StructuredMessage | null {
  return getCachedActivityValue(activityStructuredMessageCache, text, () =>
    parseStructuredAgentMessage(text)
  );
}

export function classifyIdleNotificationCached(
  message: InboxMessage
): ReturnType<typeof classifyIdleNotification> {
  return getCachedActivityValue(activityIdleSemanticCache, message.text, () =>
    classifyIdleNotification(message)
  );
}

export function getNoiseLabel(parsed: StructuredMessage): string | null {
  const type = getStringField(parsed, 'type');
  if (type === 'idle_notification') return getIdleNoiseLabel(parsed);
  if (type === 'shutdown_response')
    return parsed.approve === true ? 'Shut down' : 'Rejected shutdown';
  if (type === 'shutdown_request') return 'Shutdown requested';
  if (type === 'shutdown_approved' || type === 'teammate_terminated') {
    return type === 'shutdown_approved' ? 'Shutdown confirmed' : 'Terminated';
  }
  if (type === 'task_completed') {
    const rawTaskId = parsed.taskId;
    const taskId =
      typeof rawTaskId === 'string' || typeof rawTaskId === 'number' ? rawTaskId : null;
    return taskId !== null
      ? `Completed task ${formatTaskDisplayLabel({ id: String(taskId) })}`
      : 'Completed a task';
  }
  if (type === 'permission_request') {
    const toolName = getStringField(parsed, 'tool_name');
    return toolName ? `Permission: ${toolName}` : 'Permission request';
  }
  if (type === 'permission_response') {
    if (parsed.approved === true) return 'Permission granted';
    if (parsed.approved === false) return 'Permission denied';
    return 'Permission response';
  }
  return null;
}

export function isNoiseMessage(text: string): boolean {
  return getCachedActivityValue(activityNoiseMessageCache, text, () => {
    if (getIdleNoiseLabel(text) !== null) return true;
    const parsed = parseStructuredAgentMessageCached(text);
    return parsed !== null && getNoiseLabel(parsed) !== null;
  });
}

export function getStrippedActivityTextCached({
  message,
  structured,
  hasBootstrapDisplay,
  isCrossTeamAny,
}: {
  message: InboxMessage;
  structured: StructuredMessage | null;
  hasBootstrapDisplay: boolean;
  isCrossTeamAny: boolean;
}): string | null {
  if (structured) return null;
  const cacheKey = encodeCacheParts([
    message.text ?? '',
    message.from ?? '',
    message.to ?? '',
    message.source ?? '',
    hasBootstrapDisplay ? '1' : '0',
    isCrossTeamAny ? '1' : '0',
  ]);
  return getCachedActivityValue(activityStrippedTextCache, cacheKey, () => {
    let stripped = getSanitizedInboxMessageText(message).trim();
    if (!hasBootstrapDisplay) stripped = stripAgentBlocks(stripped).trim();
    if (!stripped) return null;
    if (isCrossTeamAny) stripped = stripCrossTeamPrefix(stripped);
    return stripped.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  });
}

const SYSTEM_MESSAGE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /^New task assigned to you:/, label: 'Task' },
  { pattern: /^Task #[A-Za-z0-9-]+\s+approved/, label: 'Task approved' },
  { pattern: /^Task #[A-Za-z0-9-]+\s+needs fixes/, label: 'Review changes requested' },
];

export function getSystemMessageLabel(text: string): string | null {
  for (const { pattern, label } of SYSTEM_MESSAGE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

export function parseQualifiedRecipient(
  value: string | undefined
): { teamName: string; memberName: string } | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  return { teamName: trimmed.slice(0, dot), memberName: trimmed.slice(dot + 1) };
}

function parseCrossTeamPseudoRecipient(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('cross-team:')) return null;
  const teamName = trimmed.slice('cross-team:'.length).trim();
  return teamName.length > 0 ? teamName : null;
}

export function isQualifiedExternalRecipient(
  value: string | undefined,
  teamName: string,
  localMemberNames?: Set<string>
): boolean {
  const recipient = parseQualifiedRecipient(value);
  if (!recipient || recipient.teamName === teamName) return false;
  return !localMemberNames?.has(value?.trim() ?? '');
}

export function getCrossTeamSentTarget(
  value: string | undefined,
  teamName: string,
  localMemberNames?: Set<string>
): string | null {
  const pseudoTarget = parseCrossTeamPseudoRecipient(value);
  if (pseudoTarget) return pseudoTarget;
  const recipient = parseQualifiedRecipient(value);
  if (!recipient || recipient.teamName === teamName || localMemberNames?.has(value?.trim() ?? '')) {
    return null;
  }
  return recipient.teamName;
}

export function getCrossTeamSentMemberName(value: string | undefined): string | null {
  return parseQualifiedRecipient(value)?.memberName ?? null;
}

export function classifyActivityMessagePresentation(
  message: InboxMessage,
  teamName: string,
  localMemberNames?: Set<string>
): ActivityMessagePresentation {
  const author = message.from?.trim() ?? '';
  const route = message.to ?? '';
  const structured = parseStructuredAgentMessageCached(message.text);
  const bootstrapDisplay = getBootstrapPromptDisplay(message);
  const bootstrapAcknowledgement = getBootstrapAcknowledgementDisplay(message);
  const rateLimited = message.from !== 'user' && isRateLimitMessage(message.text);
  const idleSemantic = classifyIdleNotificationCached(message);
  const systemLabel = !structured && !rateLimited ? getSystemMessageLabel(message.text) : null;
  const parsedCrossTeamPrefix = parseCrossTeamPrefix(message.text);
  const crossTeamSentTarget = getCrossTeamSentTarget(message.to, teamName, localMemberNames);
  const isCrossTeam = message.source === CROSS_TEAM_SOURCE || parsedCrossTeamPrefix !== null;
  const isCrossTeamSent = message.source === CROSS_TEAM_SENT_SOURCE || crossTeamSentTarget !== null;
  const isCrossTeamAny = isCrossTeam || isCrossTeamSent;
  const strippedText = getStrippedActivityTextCached({
    message,
    structured,
    hasBootstrapDisplay: bootstrapDisplay !== null,
    isCrossTeamAny,
  });
  const standaloneSlashCommand = strippedText ? parseStandaloneSlashCommand(strippedText) : null;
  const isSlashCommandResult =
    message.messageKind === 'slash_command_result' && !!message.commandOutput;
  const isSlashCommandMessage =
    !isSlashCommandResult &&
    (message.messageKind === 'slash_command' ||
      ((message.source === 'user_sent' || isCrossTeamSent) && standaloneSlashCommand !== null));
  const isApiError = message.messageKind === 'agent_error' || message.text.includes('API Error');
  const hasNonDefaultKind = Boolean(message.messageKind && message.messageKind !== 'default');
  const special =
    !author ||
    message.from === 'system' ||
    structured !== null ||
    rateLimited ||
    isApiError ||
    getNoiseLabel(structured ?? {}) !== null ||
    idleSemantic?.uiPresentation === 'peer_summary' ||
    systemLabel !== null ||
    bootstrapDisplay !== null ||
    bootstrapAcknowledgement !== null ||
    isTaskStallRemediationMessage(message) ||
    isMemberWorkSyncNudgeMessage(message) ||
    isCrossTeamAny ||
    isSlashCommandResult ||
    isSlashCommandMessage ||
    hasNonDefaultKind;

  const summary = getSanitizedInboxMessageSummary(message).trim();
  const hasRenderableBody = Boolean(
    strippedText?.trim() || summary || (message.attachments?.length && message.messageId)
  );
  return {
    kind: special ? 'special' : message.from === 'user' ? 'ordinary-user' : 'ordinary-agent',
    author,
    route,
    hasRenderableBody,
  };
}
