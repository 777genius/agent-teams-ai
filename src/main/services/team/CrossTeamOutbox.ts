import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';

import type { CrossTeamMessage, TaskRef } from '@shared/types';

const CROSS_TEAM_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export interface CrossTeamDedupeOptions {
  /** Treat message/conversation IDs as durable identities. */
  stableIdentity?: boolean;
  /** Trimmed caller-supplied ID; omit for generated IDs so conversation fallback remains active. */
  callerMessageId?: string;
  legacyToMember?: string;
}

export interface CrossTeamOutboxMessage extends CrossTeamMessage {
  /** Durable proof that exact runtime handoff was accepted for this outbox row. */
  runtimeDeliveryAcceptedAt?: string;
}

export interface CrossTeamRuntimeDeliveryProofInput {
  messageId: string;
  fromTeam: string;
  fromMember: string;
  toTeam: string;
  toMember: string;
  conversationId: string;
  text: string;
  taskRefs?: TaskRef[];
  summary?: string;
  timestamp: string;
}

export type CrossTeamRuntimeDeliveryReceiptStatus =
  | 'valid'
  | 'missing'
  | 'corrupt'
  | 'causally_stale'
  | 'superseded';

export class CrossTeamRuntimeDeliveryIdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict';

  constructor(
    readonly existingMessage: CrossTeamOutboxMessage,
    readonly runtimeDeliveryReceiptStatus: CrossTeamRuntimeDeliveryReceiptStatus = 'corrupt'
  ) {
    super('Cross-team runtime idempotency key was reused with a different payload');
    this.name = 'CrossTeamRuntimeDeliveryIdempotencyConflictError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readOptionalPayloadString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

function isTaskRef(value: unknown): value is TaskRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === 'string' &&
    value.taskId.trim().length > 0 &&
    typeof value.displayId === 'string' &&
    value.displayId.trim().length > 0 &&
    typeof value.teamName === 'string' &&
    value.teamName.trim().length > 0
  );
}

function normalizePersistedTaskRefs(value: unknown): TaskRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const taskRefs = value.filter(isTaskRef).map((taskRef) => ({
    taskId: taskRef.taskId.trim(),
    displayId: taskRef.displayId.trim(),
    teamName: taskRef.teamName.trim(),
  }));
  return taskRefs.length ? taskRefs : undefined;
}

function normalizePersistedMessage(value: unknown): CrossTeamOutboxMessage | null {
  if (!isRecord(value)) return null;

  const messageId = readRequiredString(value, 'messageId');
  const fromTeam = readRequiredString(value, 'fromTeam');
  const fromMember = readRequiredString(value, 'fromMember');
  const toTeam = readRequiredString(value, 'toTeam');
  const text = readRequiredString(value, 'text');
  const timestamp = readRequiredString(value, 'timestamp');
  if (!messageId || !fromTeam || !fromMember || !toTeam || !text || !timestamp) {
    return null;
  }

  const chainDepth =
    typeof value.chainDepth === 'number' && Number.isFinite(value.chainDepth)
      ? value.chainDepth
      : 0;
  const toMember = readOptionalString(value, 'toMember');
  const conversationId = readOptionalString(value, 'conversationId');
  const replyToConversationId = readOptionalString(value, 'replyToConversationId');
  const summary = readOptionalPayloadString(value, 'summary');
  const taskRefs = normalizePersistedTaskRefs(value.taskRefs);
  const runtimeDeliveryAcceptedAt = readOptionalString(value, 'runtimeDeliveryAcceptedAt');
  const validRuntimeDeliveryAcceptedAt =
    runtimeDeliveryAcceptedAt && Number.isFinite(Date.parse(runtimeDeliveryAcceptedAt))
      ? new Date(Date.parse(runtimeDeliveryAcceptedAt)).toISOString()
      : undefined;

  return {
    messageId,
    fromTeam,
    fromMember,
    toTeam,
    ...(toMember ? { toMember } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(replyToConversationId ? { replyToConversationId } : {}),
    text,
    ...(taskRefs ? { taskRefs } : {}),
    ...(summary !== undefined ? { summary } : {}),
    chainDepth,
    timestamp,
    ...(validRuntimeDeliveryAcceptedAt
      ? { runtimeDeliveryAcceptedAt: validRuntimeDeliveryAcceptedAt }
      : {}),
  };
}

function normalizeForDedupe(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeTaskRefsForDedupe(message: CrossTeamMessage): string {
  return message.taskRefs?.length ? JSON.stringify(message.taskRefs) : '';
}

function isExactAcceptedRuntimeDelivery(
  message: CrossTeamOutboxMessage,
  expected: CrossTeamRuntimeDeliveryProofInput
): boolean {
  return (
    message.runtimeDeliveryAcceptedAt !== undefined &&
    message.messageId.trim() === expected.messageId.trim() &&
    message.fromTeam.trim() === expected.fromTeam.trim() &&
    message.fromMember.trim() === expected.fromMember.trim() &&
    message.toTeam.trim() === expected.toTeam.trim() &&
    message.toMember?.trim() === expected.toMember.trim() &&
    message.conversationId?.trim() === expected.conversationId.trim() &&
    message.replyToConversationId === undefined &&
    message.text === expected.text &&
    (message.summary ?? '') === (expected.summary ?? '') &&
    normalizeTaskRefsForDedupe(message) ===
      normalizeTaskRefsForDedupe({ ...message, taskRefs: expected.taskRefs }) &&
    message.timestamp === expected.timestamp &&
    message.chainDepth === 0
  );
}

function hasValidRuntimeDeliveryProofShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const acceptedAtMs =
    typeof value.runtimeDeliveryAcceptedAt === 'string'
      ? Date.parse(value.runtimeDeliveryAcceptedAt)
      : Number.NaN;
  if (
    !Number.isFinite(acceptedAtMs) ||
    new Date(acceptedAtMs).toISOString() !== value.runtimeDeliveryAcceptedAt
  ) {
    return false;
  }
  if (value.summary !== undefined && typeof value.summary !== 'string') {
    return false;
  }
  if (value.replyToConversationId !== undefined) {
    return false;
  }
  if (value.chainDepth !== undefined && value.chainDepth !== 0) {
    return false;
  }
  return (
    value.taskRefs === undefined ||
    (Array.isArray(value.taskRefs) && value.taskRefs.every(isTaskRef))
  );
}

function classifyExactRuntimeDeliveryReceipt(
  rawMessage: unknown,
  message: CrossTeamOutboxMessage,
  superseded: boolean
): CrossTeamRuntimeDeliveryReceiptStatus {
  if (!isRecord(rawMessage) || rawMessage.runtimeDeliveryAcceptedAt === undefined) {
    return 'missing';
  }
  if (!hasValidRuntimeDeliveryProofShape(rawMessage)) {
    return 'corrupt';
  }

  const toMember = message.toMember?.trim();
  const conversationId = message.conversationId?.trim();
  if (
    !toMember ||
    !conversationId ||
    !isExactAcceptedRuntimeDelivery(message, {
      messageId: message.messageId,
      fromTeam: message.fromTeam,
      fromMember: message.fromMember,
      toTeam: message.toTeam,
      toMember,
      conversationId,
      text: message.text,
      taskRefs: message.taskRefs,
      summary: message.summary,
      timestamp: message.timestamp,
    })
  ) {
    return 'corrupt';
  }

  const messageTimestampMs = Date.parse(message.timestamp);
  const acceptedAtMs = Date.parse(message.runtimeDeliveryAcceptedAt!);
  if (!Number.isFinite(messageTimestampMs) || acceptedAtMs < messageTimestampMs) {
    return 'causally_stale';
  }
  return superseded ? 'superseded' : 'valid';
}

function buildCrossTeamRouteKey(message: CrossTeamMessage, legacyToMember?: string): string[] {
  return [
    normalizeForDedupe(message.fromTeam),
    normalizeForDedupe(message.fromMember),
    normalizeForDedupe(message.toTeam),
    normalizeForDedupe(message.toMember || legacyToMember),
  ];
}

function stableMessageId(message: CrossTeamMessage): string {
  return String(message.messageId ?? '').trim();
}

function stableConversationId(message: CrossTeamMessage): string {
  return String(message.conversationId ?? '').trim();
}

function buildCrossTeamDedupeKey(message: CrossTeamMessage, legacyToMember?: string): string {
  return [
    ...buildCrossTeamRouteKey(message, legacyToMember),
    normalizeForDedupe(message.summary),
    normalizeForDedupe(message.text),
    normalizeTaskRefsForDedupe(message),
  ].join('||');
}

function hasSameRoute(
  left: CrossTeamMessage,
  right: CrossTeamMessage,
  legacyToMember?: string
): boolean {
  return (
    buildCrossTeamRouteKey(left, legacyToMember).join('||') ===
    buildCrossTeamRouteKey(right).join('||')
  );
}

function buildRuntimePayloadIdentity(message: CrossTeamMessage, legacyToMember?: string): string {
  return JSON.stringify({
    route: buildCrossTeamRouteKey(message, legacyToMember),
    text: message.text,
    summary: message.summary ?? null,
    taskRefs: normalizePersistedTaskRefs(message.taskRefs) ?? [],
    replyToConversationId: message.replyToConversationId?.trim() || null,
    chainDepth: message.chainDepth,
  });
}

function hasMatchingStableIdentity(
  left: CrossTeamMessage,
  right: CrossTeamMessage,
  callerMessageId?: string
): boolean {
  const normalizedCallerMessageId = String(callerMessageId ?? '').trim();
  if (
    normalizedCallerMessageId &&
    stableMessageId(left) === normalizedCallerMessageId &&
    stableMessageId(right) === normalizedCallerMessageId
  ) {
    return true;
  }

  // conversationId is the cross-run duplicate proof. On the runtime cross-team
  // path the caller messageId is the run-scoped destinationMessageId
  // (hash of idempotencyKey + runId + teamName), so the SAME logical delivery
  // gets a DIFFERENT messageId after a relaunch while conversationId
  // (= idempotencyKey) stays stable. This durable fallback remains necessary if
  // a runtime journal is cleaned up or unavailable during a later relaunch.
  // Distinct logical messages carry distinct idempotencyKeys, hence distinct
  // conversationIds, so this cannot over-dedupe them.
  const leftConversationId = stableConversationId(left);
  const rightConversationId = stableConversationId(right);
  return Boolean(
    leftConversationId && rightConversationId && leftConversationId === rightConversationId
  );
}

function hasMatchingExactStableIdentity(
  left: CrossTeamMessage,
  right: CrossTeamMessage,
  callerMessageId?: string
): boolean {
  const normalizedCallerMessageId = String(callerMessageId ?? '').trim();
  const leftConversationId = stableConversationId(left);
  const rightConversationId = stableConversationId(right);
  return Boolean(
    normalizedCallerMessageId &&
    stableMessageId(left) === normalizedCallerMessageId &&
    stableMessageId(right) === normalizedCallerMessageId &&
    leftConversationId &&
    rightConversationId &&
    leftConversationId === rightConversationId
  );
}

function classifyCrossTeamMessageIdentity(
  entry: CrossTeamMessage,
  message: CrossTeamMessage,
  dedupeKey: string,
  options: CrossTeamDedupeOptions
): 'duplicate' | 'conflict' | null {
  if (options.stableIdentity) {
    if (
      !hasSameRoute(entry, message, options.legacyToMember) ||
      !hasMatchingStableIdentity(entry, message, options.callerMessageId)
    ) {
      return null;
    }
    const payloadMatches =
      buildRuntimePayloadIdentity(entry, options.legacyToMember) ===
      buildRuntimePayloadIdentity(message);
    return payloadMatches ||
      !hasMatchingExactStableIdentity(entry, message, options.callerMessageId)
      ? 'duplicate'
      : 'conflict';
  }

  return buildCrossTeamDedupeKey(entry, options.legacyToMember) === dedupeKey ? 'duplicate' : null;
}

function findRecentMatch(
  list: unknown[],
  message: CrossTeamMessage,
  windowMs: number,
  options: CrossTeamDedupeOptions
):
  | {
      state: 'duplicate';
      message: CrossTeamOutboxMessage;
    }
  | {
      state: 'conflict';
      message: CrossTeamOutboxMessage;
      runtimeDeliveryReceiptStatus: CrossTeamRuntimeDeliveryReceiptStatus;
    }
  | null {
  const dedupeKey = buildCrossTeamDedupeKey(message);
  const cutoff = Date.now() - windowMs;
  let duplicate: CrossTeamOutboxMessage | null = null;

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = normalizePersistedMessage(list[i]);
    if (!entry) continue;
    const ts = Date.parse(entry.timestamp);
    if (!options.stableIdentity && (!Number.isFinite(ts) || ts < cutoff)) {
      continue;
    }
    const state = classifyCrossTeamMessageIdentity(entry, message, dedupeKey, options);
    if (state === 'conflict') {
      const superseded = list.slice(i + 1).some((candidate) => {
        const newerEntry = normalizePersistedMessage(candidate);
        return (
          newerEntry !== null &&
          hasMatchingStableIdentity(newerEntry, message, options.callerMessageId)
        );
      });
      return {
        state,
        message: entry,
        runtimeDeliveryReceiptStatus: classifyExactRuntimeDeliveryReceipt(
          list[i],
          entry,
          superseded
        ),
      };
    }
    if (state === 'duplicate' && !duplicate) {
      duplicate = entry;
    }
  }

  return duplicate ? { state: 'duplicate', message: duplicate } : null;
}

export class CrossTeamOutbox {
  private getOutboxPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'sent-cross-team.json');
  }

  private async readUnlocked(outboxPath: string): Promise<unknown[]> {
    try {
      const raw = await fs.promises.readFile(outboxPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map((entry: unknown) => entry) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async append(teamName: string, message: CrossTeamMessage): Promise<void> {
    const outboxPath = this.getOutboxPath(teamName);
    await withFileLock(outboxPath, async () => {
      const list = await this.readUnlocked(outboxPath);
      list.push(message);
      await atomicWriteAsync(outboxPath, JSON.stringify(list, null, 2));
    });
  }

  async appendIfNotRecent(
    teamName: string,
    message: CrossTeamMessage,
    onBeforeAppend: () => Promise<void>,
    windowMs = CROSS_TEAM_DEDUPE_WINDOW_MS,
    options: CrossTeamDedupeOptions = {}
  ): Promise<{ duplicate: CrossTeamOutboxMessage | null }> {
    const outboxPath = this.getOutboxPath(teamName);
    let duplicate: CrossTeamOutboxMessage | null = null;

    await withFileLock(outboxPath, async () => {
      const list = await this.readUnlocked(outboxPath);
      const match = findRecentMatch(list, message, windowMs, options);
      if (match?.state === 'conflict') {
        throw new CrossTeamRuntimeDeliveryIdempotencyConflictError(
          match.message,
          match.runtimeDeliveryReceiptStatus
        );
      }
      duplicate = match?.message ?? null;
      if (duplicate) return;

      await onBeforeAppend();

      list.push(message);
      await atomicWriteAsync(outboxPath, JSON.stringify(list, null, 2));
    });

    return { duplicate };
  }

  async markRuntimeDeliveryAccepted(
    teamName: string,
    input: {
      messageId: string;
      toTeam: string;
      toMember: string;
      acceptedAt: string;
    }
  ): Promise<void> {
    const outboxPath = this.getOutboxPath(teamName);
    const messageId = input.messageId.trim();
    const toTeam = input.toTeam.trim();
    const toMember = input.toMember.trim();
    const acceptedAtMs = Date.parse(input.acceptedAt);
    if (!messageId || !toTeam || !toMember || !Number.isFinite(acceptedAtMs)) {
      throw new Error('Invalid cross-team runtime delivery receipt');
    }
    const acceptedAt = new Date(acceptedAtMs).toISOString();
    let marked = false;

    await withFileLock(outboxPath, async () => {
      const list = await this.readUnlocked(outboxPath);
      const matchingIndexes = list.flatMap((entry, index) => {
        const message = normalizePersistedMessage(entry);
        const matches =
          message?.messageId.trim() === messageId &&
          message.toTeam.trim() === toTeam &&
          message.toMember?.trim() === toMember;
        return matches ? [index] : [];
      });
      if (matchingIndexes.length !== 1) {
        return;
      }
      const index = matchingIndexes.at(0);
      if (index === undefined) {
        return;
      }
      const row = list[index];
      if (!isRecord(row)) {
        return;
      }
      list[index] = { ...row, runtimeDeliveryAcceptedAt: acceptedAt };
      await atomicWriteAsync(outboxPath, JSON.stringify(list, null, 2));
      const written = await this.readUnlocked(outboxPath);
      marked = written.some((entry) => {
        const message = normalizePersistedMessage(entry);
        return (
          message?.messageId.trim() === messageId &&
          message.toTeam.trim() === toTeam &&
          message.toMember?.trim() === toMember &&
          message.runtimeDeliveryAcceptedAt === acceptedAt
        );
      });
    });

    if (!marked) {
      throw new Error(`Failed to persist cross-team runtime delivery receipt: ${messageId}`);
    }
  }

  async findAcceptedRuntimeDelivery(
    teamName: string,
    expected: CrossTeamRuntimeDeliveryProofInput
  ): Promise<CrossTeamOutboxMessage | null> {
    const outboxPath = this.getOutboxPath(teamName);
    const list = await this.readUnlocked(outboxPath);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (!hasValidRuntimeDeliveryProofShape(list[index])) {
        continue;
      }
      const message = normalizePersistedMessage(list[index]);
      if (message && isExactAcceptedRuntimeDelivery(message, expected)) {
        return message;
      }
    }
    return null;
  }

  async read(teamName: string): Promise<CrossTeamMessage[]> {
    const outboxPath = this.getOutboxPath(teamName);
    const list = await this.readUnlocked(outboxPath);
    return list
      .map((entry) => normalizePersistedMessage(entry))
      .filter((entry): entry is CrossTeamMessage => entry !== null);
  }
}
