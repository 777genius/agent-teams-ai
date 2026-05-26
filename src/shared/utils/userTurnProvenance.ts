export type UserTurnProvenanceKind =
  | 'human'
  | 'synthetic-replay'
  | 'coordinator'
  | 'teammate-protocol'
  | 'task-notification'
  | 'channel'
  | 'cross-session'
  | 'tick'
  | 'tool-result'
  | 'local-command-output';

export interface MessageOriginLike {
  kind?: string;
}

export interface UserTurnProvenanceInput {
  type?: string;
  isMeta?: boolean;
  isSynthetic?: boolean;
  isReplay?: boolean;
  isCompactSummary?: boolean;
  toolUseResult?: unknown;
  sourceToolUseID?: unknown;
  origin?: MessageOriginLike;
  protocolKind?: string;
  content?: unknown;
  message?: {
    content?: unknown;
  };
  toolResults?: readonly unknown[];
}

const LOCAL_COMMAND_STDOUT_TAG = 'local-command-stdout';
const LOCAL_COMMAND_STDERR_TAG = 'local-command-stderr';
const BASH_STDOUT_TAG = 'bash-stdout';
const BASH_STDERR_TAG = 'bash-stderr';
const TEAMMATE_MESSAGE_TAG = 'teammate-message';
const TASK_NOTIFICATION_TAG = 'task-notification';
const CHANNEL_MESSAGE_TAG = 'channel-message';
const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message';
const TICK_TAG = 'tick';

export function classifyUserTurnProvenance(
  message: UserTurnProvenanceInput
): UserTurnProvenanceKind {
  if (hasToolResultProvenance(message)) {
    return 'tool-result';
  }

  if (hasSystemOutputContent(getMessageContent(message))) {
    return 'local-command-output';
  }

  if (message.isCompactSummary === true) {
    return 'synthetic-replay';
  }

  const protocolKind = normalizeProtocolKind(message.protocolKind);
  if (protocolKind) {
    return protocolKind;
  }

  const originKind = normalizeOriginKind(message.origin);
  if (originKind) {
    return originKind;
  }

  const legacyProtocolKind = classifyLegacyProtocolText(
    getTextContent(getMessageContent(message))
  );
  if (legacyProtocolKind) {
    return legacyProtocolKind;
  }

  if (message.isSynthetic === true) {
    return 'synthetic-replay';
  }

  if (message.isMeta === true) {
    return 'coordinator';
  }

  return 'human';
}

export function isHumanAuthoredUserTurn(message: UserTurnProvenanceInput): boolean {
  return classifyUserTurnProvenance(message) === 'human';
}

export function isSyntheticReplayNoise(message: UserTurnProvenanceInput): boolean {
  return (
    message.isSynthetic === true &&
    message.isReplay === true &&
    !hasToolResultPayload(message) &&
    !hasSystemOutputContent(getMessageContent(message))
  );
}

export function isDisplayableTeammateProtocol(
  message: UserTurnProvenanceInput
): boolean {
  return (
    classifyUserTurnProvenance(message) === 'teammate-protocol' &&
    message.isMeta !== true &&
    message.isSynthetic !== true
  );
}

function normalizeProtocolKind(
  protocolKind: string | undefined
): UserTurnProvenanceKind | undefined {
  switch (protocolKind) {
    case TEAMMATE_MESSAGE_TAG:
      return 'teammate-protocol';
    case TASK_NOTIFICATION_TAG:
      return 'task-notification';
    case CHANNEL_MESSAGE_TAG:
      return 'channel';
    case CROSS_SESSION_MESSAGE_TAG:
      return 'cross-session';
    case TICK_TAG:
      return 'tick';
    default:
      return undefined;
  }
}

function normalizeOriginKind(
  origin: MessageOriginLike | undefined
): UserTurnProvenanceKind | undefined {
  switch (origin?.kind) {
    case undefined:
    case 'human':
      return undefined;
    case 'task-notification':
      return 'task-notification';
    case 'channel':
      return 'channel';
    case 'cross-session':
      return 'cross-session';
    case 'tick':
      return 'tick';
    case 'teammate':
      return 'teammate-protocol';
    case 'coordinator':
    default:
      return 'coordinator';
  }
}

function classifyLegacyProtocolText(
  text: string | undefined
): UserTurnProvenanceKind | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = stripTranscriptSpeakerPrefix(text.trimStart());
  if (normalized.startsWith(`<${TEAMMATE_MESSAGE_TAG}`)) {
    return 'teammate-protocol';
  }
  if (normalized.startsWith(`<${TASK_NOTIFICATION_TAG}`)) {
    return 'task-notification';
  }
  if (normalized.startsWith(`<${CHANNEL_MESSAGE_TAG}`)) {
    return 'channel';
  }
  if (normalized.startsWith(`<${CROSS_SESSION_MESSAGE_TAG}`)) {
    return 'cross-session';
  }
  if (normalized.startsWith(`<${TICK_TAG}`)) {
    return 'tick';
  }
  return undefined;
}

function stripTranscriptSpeakerPrefix(text: string): string {
  return text.replace(/^(?:Human|User):\s*/i, '').trimStart();
}

function hasToolResultProvenance(message: UserTurnProvenanceInput): boolean {
  if (message.toolUseResult !== undefined || message.sourceToolUseID !== undefined) {
    return true;
  }
  if ((message.toolResults?.length ?? 0) > 0) {
    return true;
  }
  return hasToolResultContent(message);
}

function hasToolResultPayload(message: UserTurnProvenanceInput): boolean {
  return (
    message.toolUseResult !== undefined ||
    message.sourceToolUseID !== undefined ||
    (message.toolResults?.length ?? 0) > 0 ||
    hasToolResultContent(message)
  );
}

function hasToolResultContent(message: UserTurnProvenanceInput): boolean {
  const content = getMessageContent(message);
  return (
    Array.isArray(content) &&
    content.some((block) => isContentBlock(block) && block.type === 'tool_result')
  );
}

function hasSystemOutputContent(content: unknown): boolean {
  if (typeof content === 'string') {
    return startsWithSystemOutputTag(content);
  }

  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        isContentBlock(block) &&
        block.type === 'text' &&
        startsWithSystemOutputTag(block.text)
    )
  );
}

function startsWithSystemOutputTag(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return (
    text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
    text.startsWith(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
    text.startsWith(`<${BASH_STDOUT_TAG}>`) ||
    text.startsWith(`<${BASH_STDERR_TAG}>`)
  );
}

function getMessageContent(message: UserTurnProvenanceInput): unknown {
  return message.message?.content ?? message.content;
}

function getTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .filter(isContentBlock)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function isContentBlock(value: unknown): value is { type?: string; text?: string } {
  return value !== null && typeof value === 'object';
}
