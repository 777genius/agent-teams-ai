import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';
import { withInboxLock } from './inboxLock';
import { getEffectiveInboxMessageId } from './inboxMessageIdentity';

import type { InboxMessage, SendMessageRequest, SendMessageResult, TaskRef } from '@shared/types';

type MutableInboxMessage = InboxMessage & Record<string, unknown>;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseInboxForMutation(raw: string): MutableInboxMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Refusing to replace malformed team inbox', { cause: error });
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (item) =>
        isJsonRecord(item) &&
        typeof item.from === 'string' &&
        typeof item.text === 'string' &&
        typeof item.timestamp === 'string' &&
        typeof item.read === 'boolean'
    )
  ) {
    throw new Error('Refusing to replace malformed team inbox');
  }
  return parsed as MutableInboxMessage[];
}

function realpathIfExists(inputPath: string): string | null {
  try {
    return fs.realpathSync.native(inputPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

function resolveInboxPath(teamName: string, inboxName: string): string {
  const safeTeamName = teamName.trim();
  const safeInboxName = inboxName.trim();
  if (!validateFileName(safeTeamName).valid || !validateFileName(safeInboxName).valid) {
    throw new Error('Invalid inbox path');
  }

  const teamsBasePath = getTeamsBasePath();
  const teamDir = path.join(teamsBasePath, safeTeamName);
  const inboxDir = path.join(teamsBasePath, safeTeamName, 'inboxes');
  const inboxPath = path.join(inboxDir, `${safeInboxName}.json`);
  if (
    !isPathWithinRoot(teamDir, teamsBasePath) ||
    !isPathWithinRoot(inboxDir, teamDir) ||
    !isPathWithinRoot(inboxPath, inboxDir)
  ) {
    throw new Error('Invalid inbox path');
  }

  const realTeamsBasePath = realpathIfExists(teamsBasePath) ?? path.resolve(teamsBasePath);
  const realTeamDir = realpathIfExists(teamDir);
  if (realTeamDir && !isPathWithinRoot(realTeamDir, realTeamsBasePath)) {
    throw new Error('Invalid inbox path');
  }

  const teamRootForRealCheck = realTeamDir ?? path.resolve(teamDir);
  const realInboxDir = realpathIfExists(inboxDir);
  if (
    realInboxDir &&
    (!isPathWithinRoot(realInboxDir, teamRootForRealCheck) ||
      !isPathWithinRoot(realInboxDir, realTeamsBasePath))
  ) {
    throw new Error('Invalid inbox path');
  }

  const inboxRootForRealCheck = realInboxDir ?? path.resolve(inboxDir);
  const realInboxPath = realpathIfExists(inboxPath);
  if (
    realInboxPath &&
    (!isPathWithinRoot(realInboxPath, inboxRootForRealCheck) ||
      !isPathWithinRoot(realInboxPath, teamRootForRealCheck) ||
      !isPathWithinRoot(realInboxPath, realTeamsBasePath))
  ) {
    throw new Error('Invalid inbox path');
  }

  return inboxPath;
}

export interface UpdateInboxMessageTextRequest {
  member: string;
  messageId: string;
  text: string;
  expectedMessageKind?: InboxMessage['messageKind'];
  expectedWorkSyncPayloadHash?: string;
}

export interface UpdateInboxMessageTextResult {
  found: boolean;
  updated: boolean;
}

export interface MergeRuntimeDeliveryTaskRefsRequest {
  inboxName: string;
  messageId: string;
  relayOfMessageId: string;
  from: string;
  taskRefs: TaskRef[];
}

export interface MergeRuntimeDeliveryTaskRefsResult {
  found: boolean;
  updated: boolean;
  message?: InboxMessage & { messageId: string };
}

export interface CorrelateRuntimeDeliveryReplyRequest {
  inboxName: string;
  messageId: string;
  relayOfMessageId: string;
  from: string;
  taskRefs?: TaskRef[];
}

export interface CorrelateRuntimeDeliveryReplyResult {
  found: boolean;
  updated: boolean;
  message?: InboxMessage & { messageId: string };
}

export class TeamInboxWriter {
  async sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const inboxPath = resolveInboxPath(teamName, request.member);
    const explicitMessageId = request.messageId?.trim();
    const messageId = explicitMessageId || randomUUID();

    const attachmentMeta = request.attachments?.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    }));

    const payload: InboxMessage = {
      from: request.from ?? 'user',
      to: request.to ?? request.member,
      text: request.text,
      timestamp: request.timestamp ?? new Date().toISOString(),
      read: false,
      taskRefs: request.taskRefs?.length ? request.taskRefs : undefined,
      actionMode: request.actionMode,
      commentId: typeof request.commentId === 'string' ? request.commentId : undefined,
      summary: request.summary,
      messageId,
      ...(request.relayOfMessageId && { relayOfMessageId: request.relayOfMessageId }),
      attachments: attachmentMeta?.length ? attachmentMeta : undefined,
      ...(request.source && { source: request.source }),
      ...(request.leadSessionId && { leadSessionId: request.leadSessionId }),
      ...(request.color && { color: request.color }),
      ...(request.conversationId && { conversationId: request.conversationId }),
      ...(request.replyToConversationId && {
        replyToConversationId: request.replyToConversationId,
      }),
      ...(request.toolSummary && { toolSummary: request.toolSummary }),
      ...(request.toolCalls && { toolCalls: request.toolCalls }),
      ...(request.messageKind && { messageKind: request.messageKind }),
      ...(request.agentError && { agentError: request.agentError }),
      ...(request.runtimeRecovery && { runtimeRecovery: request.runtimeRecovery }),
      ...(request.workSyncIntent && { workSyncIntent: request.workSyncIntent }),
      ...(request.workSyncIntentKey && { workSyncIntentKey: request.workSyncIntentKey }),
      ...(request.workSyncReviewRequestEventIds?.length
        ? { workSyncReviewRequestEventIds: request.workSyncReviewRequestEventIds }
        : {}),
      ...(request.workSyncPayloadHash ? { workSyncPayloadHash: request.workSyncPayloadHash } : {}),
      ...(request.slashCommand && { slashCommand: request.slashCommand }),
      ...(request.commandOutput && { commandOutput: request.commandOutput }),
    };
    let resultMessageId = messageId;
    let resultDeduplicated = false;

    await withFileLock(inboxPath, async () => {
      await withInboxLock(inboxPath, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const list = await this.readInbox(inboxPath);
          const explicitDuplicateIndex = explicitMessageId
            ? this.findExplicitMessageIdDuplicateIndex(list, explicitMessageId)
            : -1;
          const matchedExplicitMessageId = explicitDuplicateIndex >= 0;
          const duplicateIndex = matchedExplicitMessageId
            ? explicitDuplicateIndex
            : this.findRuntimeDeliveryDuplicateIndex(list, payload);
          if (duplicateIndex >= 0) {
            const duplicate = list[duplicateIndex];
            if (matchedExplicitMessageId) {
              this.assertMatchingExplicitMessagePayload(duplicate, payload, messageId);
            }
            const merged = this.mergeTaskRefs(duplicate.taskRefs, payload.taskRefs);
            resultMessageId = duplicate.messageId ?? messageId;
            resultDeduplicated = true;
            if (merged.changed) {
              list[duplicateIndex] = {
                ...duplicate,
                taskRefs: merged.taskRefs,
              };
              await atomicWriteAsync(inboxPath, JSON.stringify(list, null, 2));
              const written = await this.readInbox(inboxPath);
              const writtenDuplicateIndex = matchedExplicitMessageId
                ? this.findExplicitMessageIdDuplicateIndex(written, messageId)
                : this.findRuntimeDeliveryDuplicateIndex(written, payload);
              const writtenDuplicate =
                writtenDuplicateIndex >= 0 ? written[writtenDuplicateIndex] : null;
              if (
                writtenDuplicate &&
                this.taskRefsIncludeAll(writtenDuplicate.taskRefs, payload.taskRefs ?? [])
              ) {
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
              continue;
            }
            return;
          }
          list.push(payload);
          await atomicWriteAsync(inboxPath, JSON.stringify(list, null, 2));
          const written = await this.readInbox(inboxPath);
          if (written.some((msg) => msg.messageId === messageId)) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
        }
        throw new Error('Failed to verify inbox write');
      });
    });

    return {
      deliveredToInbox: true,
      messageId: resultMessageId,
      ...(resultDeduplicated ? { deduplicated: true } : {}),
    };
  }

  private findExplicitMessageIdDuplicateIndex(
    messages: readonly InboxMessage[],
    messageId: string
  ): number {
    return messages.findIndex(
      (candidate) =>
        typeof candidate.messageId === 'string' && candidate.messageId.trim() === messageId
    );
  }

  private assertMatchingExplicitMessagePayload(
    existing: InboxMessage,
    incoming: InboxMessage,
    messageId: string
  ): void {
    if (
      isDeepStrictEqual(
        this.getImmutableExplicitMessagePayload(existing),
        this.getImmutableExplicitMessagePayload(incoming)
      )
    ) {
      return;
    }
    throw new Error(`Inbox messageId collision for immutable payload: ${messageId}`);
  }

  private getImmutableExplicitMessagePayload(message: InboxMessage): Record<string, unknown> {
    const isRuntimeDelivery = message.source === 'runtime_delivery';
    return {
      from: isRuntimeDelivery ? this.normalizeComparableParticipant(message.from) : message.from,
      to: isRuntimeDelivery ? this.normalizeComparableParticipant(message.to) : message.to,
      text: isRuntimeDelivery ? this.normalizeComparableText(message.text) : message.text,
      actionMode: message.actionMode,
      commentId: message.commentId,
      summary: message.summary,
      relayOfMessageId: isRuntimeDelivery
        ? message.relayOfMessageId?.trim()
        : message.relayOfMessageId,
      attachments: message.attachments,
      source: message.source,
      conversationId: message.conversationId,
      replyToConversationId: message.replyToConversationId,
      toolSummary: message.toolSummary,
      toolCalls: message.toolCalls,
      messageKind: message.messageKind,
      workSyncIntent: message.workSyncIntent,
      workSyncIntentKey: message.workSyncIntentKey,
      workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
      workSyncPayloadHash: message.workSyncPayloadHash,
      slashCommand: message.slashCommand,
      commandOutput: message.commandOutput,
    };
  }

  async updateMessageText(
    teamName: string,
    request: UpdateInboxMessageTextRequest
  ): Promise<UpdateInboxMessageTextResult> {
    const messageId = request.messageId.trim();
    if (!messageId) {
      return { found: false, updated: false };
    }

    const inboxPath = resolveInboxPath(teamName, request.member);
    let result: UpdateInboxMessageTextResult = { found: false, updated: false };

    await withFileLock(inboxPath, async () => {
      await withInboxLock(inboxPath, async () => {
        let raw: string;
        try {
          raw = await fs.promises.readFile(inboxPath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
          }
          throw error;
        }

        const parsed = parseInboxForMutation(raw);

        let changed = false;
        for (const row of parsed) {
          const rowMessageId = getEffectiveInboxMessageId(row);
          if (rowMessageId !== messageId) {
            continue;
          }
          result = { found: true, updated: changed };
          if (request.expectedMessageKind && row.messageKind !== request.expectedMessageKind) {
            continue;
          }
          if (
            request.expectedWorkSyncPayloadHash &&
            row.workSyncPayloadHash !== request.expectedWorkSyncPayloadHash
          ) {
            continue;
          }
          if (row.text === request.text) {
            continue;
          }
          row.text = request.text;
          changed = true;
          result = { found: true, updated: true };
        }

        if (!changed) {
          return;
        }
        await atomicWriteAsync(inboxPath, JSON.stringify(parsed, null, 2));
      });
    });

    return result;
  }

  async mergeRuntimeDeliveryTaskRefs(
    teamName: string,
    request: MergeRuntimeDeliveryTaskRefsRequest
  ): Promise<MergeRuntimeDeliveryTaskRefsResult> {
    const inboxName = request.inboxName.trim();
    const messageId = request.messageId.trim();
    const relayOfMessageId = request.relayOfMessageId.trim();
    const taskRefs = this.normalizeTaskRefs(request.taskRefs);
    if (!inboxName || !messageId || !relayOfMessageId || taskRefs.length === 0) {
      return { found: false, updated: false };
    }

    const inboxPath = resolveInboxPath(teamName, inboxName);
    const expectedFrom = this.normalizeComparableParticipant(request.from);
    if (!expectedFrom) {
      return { found: false, updated: false };
    }

    let result: MergeRuntimeDeliveryTaskRefsResult = { found: false, updated: false };
    await withFileLock(inboxPath, async () => {
      await withInboxLock(inboxPath, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const list = await this.readInbox(inboxPath);
          const index = list.findIndex((message) => {
            const rowMessageId =
              typeof message.messageId === 'string' ? message.messageId.trim() : '';
            const rowRelayOf =
              typeof message.relayOfMessageId === 'string' ? message.relayOfMessageId.trim() : '';
            const rowSource = message.source;
            return (
              rowMessageId === messageId &&
              rowRelayOf === relayOfMessageId &&
              this.normalizeComparableParticipant(message.from) === expectedFrom &&
              (rowSource === undefined || rowSource === 'runtime_delivery')
            );
          });
          if (index < 0) {
            result = { found: false, updated: false };
            return;
          }

          const existing = list[index];
          const merged = this.mergeTaskRefs(existing.taskRefs, taskRefs);
          if (!merged.changed) {
            result = {
              found: true,
              updated: false,
              message: { ...existing, messageId },
            };
            return;
          }

          list[index] = { ...existing, taskRefs: merged.taskRefs };
          await atomicWriteAsync(inboxPath, JSON.stringify(list, null, 2));
          const written = await this.readInbox(inboxPath);
          const verified = written.find((message) => {
            const rowMessageId =
              typeof message.messageId === 'string' ? message.messageId.trim() : '';
            const rowRelayOf =
              typeof message.relayOfMessageId === 'string' ? message.relayOfMessageId.trim() : '';
            const rowSource = message.source;
            return (
              rowMessageId === messageId &&
              rowRelayOf === relayOfMessageId &&
              this.normalizeComparableParticipant(message.from) === expectedFrom &&
              (rowSource === undefined || rowSource === 'runtime_delivery') &&
              this.taskRefsIncludeAll(message.taskRefs, taskRefs)
            );
          });
          if (verified) {
            result = {
              found: true,
              updated: true,
              message: { ...verified, messageId },
            };
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
        }
        throw new Error('Failed to verify inbox taskRefs merge');
      });
    });

    return result;
  }

  async correlateRuntimeDeliveryReply(
    teamName: string,
    request: CorrelateRuntimeDeliveryReplyRequest
  ): Promise<CorrelateRuntimeDeliveryReplyResult> {
    const inboxName = request.inboxName.trim();
    const messageId = request.messageId.trim();
    const relayOfMessageId = request.relayOfMessageId.trim();
    const expectedFrom = this.normalizeComparableParticipant(request.from);
    if (!inboxName || !messageId || !relayOfMessageId || !expectedFrom) {
      return { found: false, updated: false };
    }

    const inboxPath = resolveInboxPath(teamName, inboxName);
    const taskRefs = this.normalizeTaskRefs(request.taskRefs);
    let result: CorrelateRuntimeDeliveryReplyResult = { found: false, updated: false };
    await withFileLock(inboxPath, async () => {
      await withInboxLock(inboxPath, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const list = await this.readInbox(inboxPath);
          const index = list.findIndex((message) => {
            const rowMessageId =
              typeof message.messageId === 'string' ? message.messageId.trim() : '';
            const rowSource = message.source;
            return (
              rowMessageId === messageId &&
              this.normalizeComparableParticipant(message.from) === expectedFrom &&
              (rowSource === undefined || rowSource === 'runtime_delivery')
            );
          });
          if (index < 0) {
            result = { found: false, updated: false };
            return;
          }

          const existing = list[index];
          const merged = this.mergeTaskRefs(existing.taskRefs, taskRefs);
          const currentRelayOf =
            typeof existing.relayOfMessageId === 'string' ? existing.relayOfMessageId.trim() : '';
          if (currentRelayOf === relayOfMessageId && !merged.changed) {
            result = {
              found: true,
              updated: false,
              message: { ...existing, messageId },
            };
            return;
          }

          const nextMessage: InboxMessage = {
            ...existing,
            relayOfMessageId,
            ...(merged.taskRefs ? { taskRefs: merged.taskRefs } : {}),
          };
          list[index] = nextMessage;
          await atomicWriteAsync(inboxPath, JSON.stringify(list, null, 2));
          const written = await this.readInbox(inboxPath);
          const verified = written.find((message) => {
            const rowMessageId =
              typeof message.messageId === 'string' ? message.messageId.trim() : '';
            const rowRelayOf =
              typeof message.relayOfMessageId === 'string' ? message.relayOfMessageId.trim() : '';
            const rowSource = message.source;
            return (
              rowMessageId === messageId &&
              rowRelayOf === relayOfMessageId &&
              this.normalizeComparableParticipant(message.from) === expectedFrom &&
              (rowSource === undefined || rowSource === 'runtime_delivery') &&
              this.taskRefsIncludeAll(message.taskRefs, taskRefs)
            );
          });
          if (verified) {
            result = {
              found: true,
              updated: true,
              message: { ...verified, messageId },
            };
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
        }
        throw new Error('Failed to verify inbox runtime delivery correlation update');
      });
    });

    return result;
  }

  private findRuntimeDeliveryDuplicateIndex(
    messages: readonly InboxMessage[],
    payload: InboxMessage
  ): number {
    if (
      payload.source !== 'runtime_delivery' ||
      typeof payload.relayOfMessageId !== 'string' ||
      payload.relayOfMessageId.trim().length === 0
    ) {
      return -1;
    }

    const relayOfMessageId = payload.relayOfMessageId.trim();
    const from = this.normalizeComparableParticipant(payload.from);
    const to = this.normalizeComparableParticipant(payload.to);
    const text = this.normalizeComparableText(payload.text);
    if (!from || !to || !text) {
      return -1;
    }

    return messages.findIndex(
      (candidate) =>
        candidate.source === 'runtime_delivery' &&
        (candidate.relayOfMessageId ?? '').trim() === relayOfMessageId &&
        this.normalizeComparableParticipant(candidate.from) === from &&
        this.normalizeComparableParticipant(candidate.to) === to &&
        this.normalizeComparableText(candidate.text) === text
    );
  }

  private mergeTaskRefs(
    existing: readonly TaskRef[] | undefined,
    incoming: readonly TaskRef[] | undefined
  ): { changed: boolean; taskRefs?: TaskRef[] } {
    const normalizedExisting = this.normalizeTaskRefs(existing);
    const normalizedIncoming = this.normalizeTaskRefs(incoming);
    if (normalizedIncoming.length === 0) {
      return {
        changed: false,
        taskRefs: normalizedExisting.length ? normalizedExisting : undefined,
      };
    }

    const seen = new Set(normalizedExisting.map((taskRef) => this.taskRefKey(taskRef)));
    const merged = [...normalizedExisting];
    let changed = false;
    for (const taskRef of normalizedIncoming) {
      const key = this.taskRefKey(taskRef);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(taskRef);
      changed = true;
    }
    return { changed, taskRefs: merged.length ? merged : undefined };
  }

  private taskRefsIncludeAll(
    actual: readonly TaskRef[] | undefined,
    expected: readonly TaskRef[]
  ): boolean {
    const actualKeys = new Set(
      this.normalizeTaskRefs(actual).map((taskRef) => this.taskRefKey(taskRef))
    );
    return this.normalizeTaskRefs(expected).every((taskRef) =>
      actualKeys.has(this.taskRefKey(taskRef))
    );
  }

  private normalizeTaskRefs(taskRefs: readonly TaskRef[] | undefined): TaskRef[] {
    if (!Array.isArray(taskRefs)) {
      return [];
    }
    const normalized: TaskRef[] = [];
    for (const rawTaskRef of taskRefs as readonly unknown[]) {
      if (!rawTaskRef || typeof rawTaskRef !== 'object') {
        continue;
      }
      const taskRef = rawTaskRef as Record<string, unknown>;
      const teamName = typeof taskRef.teamName === 'string' ? taskRef.teamName.trim() : '';
      const taskId = typeof taskRef.taskId === 'string' ? taskRef.taskId.trim() : '';
      const displayId = typeof taskRef.displayId === 'string' ? taskRef.displayId.trim() : '';
      if (teamName && taskId && displayId) {
        normalized.push({ teamName, taskId, displayId });
      }
    }
    return normalized;
  }

  private taskRefKey(taskRef: TaskRef): string {
    return `${taskRef.teamName.trim()}\u0000${taskRef.taskId.trim()}\u0000${taskRef.displayId.trim()}`;
  }

  private normalizeComparableParticipant(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private normalizeComparableText(value: unknown): string {
    return typeof value === 'string'
      ? value
          .trim()
          .replace(/\r\n/g, '\n')
          .replace(/[ \t]+/g, ' ')
      : '';
  }

  private async readInbox(inboxPath: string): Promise<InboxMessage[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(inboxPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return parseInboxForMutation(raw);
  }
}
