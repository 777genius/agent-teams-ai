import { toMessageKey } from '@renderer/utils/teamMessageKey';

import type { AttachmentMeta, InboxMessage, TaskRef, ToolCallMeta } from '@shared/types';

export function areStringArraysEqual(
  prev: readonly string[] | undefined,
  next: readonly string[] | undefined
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }

  return true;
}

export function areStringMapsEqual(
  prev: ReadonlyMap<string, string> | undefined,
  next: ReadonlyMap<string, string> | undefined
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  if (prev.size !== next.size) return false;

  for (const [key, value] of prev) {
    if (next.get(key) !== value) return false;
  }

  return true;
}

export function areTaskRefsEqual(prev?: readonly TaskRef[], next?: readonly TaskRef[]): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i++) {
    if (
      prev[i].taskId !== next[i].taskId ||
      prev[i].displayId !== next[i].displayId ||
      prev[i].teamName !== next[i].teamName
    ) {
      return false;
    }
  }

  return true;
}

export function areAttachmentsEqual(
  prev?: readonly AttachmentMeta[],
  next?: readonly AttachmentMeta[]
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i++) {
    if (
      prev[i].id !== next[i].id ||
      prev[i].filename !== next[i].filename ||
      prev[i].mimeType !== next[i].mimeType ||
      prev[i].size !== next[i].size
    ) {
      return false;
    }
  }

  return true;
}

export function areToolCallsEqual(
  prev?: readonly ToolCallMeta[],
  next?: readonly ToolCallMeta[]
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i++) {
    if (prev[i].name !== next[i].name || prev[i].preview !== next[i].preview) {
      return false;
    }
  }

  return true;
}

export function areSlashCommandsEqual(
  prev?: InboxMessage['slashCommand'],
  next?: InboxMessage['slashCommand']
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  return (
    prev.name === next.name &&
    prev.command === next.command &&
    prev.args === next.args &&
    prev.knownDescription === next.knownDescription
  );
}

export function areCommandOutputsEqual(
  prev?: InboxMessage['commandOutput'],
  next?: InboxMessage['commandOutput']
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  return prev.stream === next.stream && prev.commandLabel === next.commandLabel;
}

export function areInboxMessagesEquivalentForRender(
  prev: InboxMessage,
  next: InboxMessage
): boolean {
  if (prev === next) return true;
  if (toMessageKey(prev) !== toMessageKey(next)) return false;
  if (prev.messageId !== next.messageId) return false;
  if (prev.timestamp !== next.timestamp) return false;
  if (prev.from !== next.from) return false;
  if (prev.to !== next.to) return false;
  if (prev.text !== next.text) return false;
  if (prev.summary !== next.summary) return false;
  if (prev.color !== next.color) return false;
  if (prev.read !== next.read) return false;
  if (prev.relayOfMessageId !== next.relayOfMessageId) return false;
  if (prev.source !== next.source) return false;
  if (prev.leadSessionId !== next.leadSessionId) return false;
  if (prev.toolSummary !== next.toolSummary) return false;
  if (prev.messageKind !== next.messageKind) return false;

  return (
    areTaskRefsEqual(prev.taskRefs, next.taskRefs) &&
    areAttachmentsEqual(prev.attachments, next.attachments) &&
    areSlashCommandsEqual(prev.slashCommand, next.slashCommand) &&
    areCommandOutputsEqual(prev.commandOutput, next.commandOutput)
  );
}

export function areThoughtMessagesEquivalentForRender(
  prev: InboxMessage,
  next: InboxMessage
): boolean {
  if (prev === next) return true;
  if (toMessageKey(prev) !== toMessageKey(next)) return false;
  if (prev.messageId !== next.messageId) return false;
  if (prev.timestamp !== next.timestamp) return false;
  if (prev.text !== next.text) return false;
  if (prev.toolSummary !== next.toolSummary) return false;

  return (
    areTaskRefsEqual(prev.taskRefs, next.taskRefs) &&
    areToolCallsEqual(prev.toolCalls, next.toolCalls)
  );
}
