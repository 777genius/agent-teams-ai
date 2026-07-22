import { createHash } from 'node:crypto';

import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';
import * as fs from 'fs';
import * as path from 'path';

import { estimateCachedValueBytes } from './cacheMemoryEstimate';
import { getEffectiveInboxMessageId } from './inboxMessageIdentity';

import type { InboxMessage } from '@shared/types';

export const MAX_INBOX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — skip corrupt/oversized inbox files
const INBOX_READ_CONCURRENCY = process.platform === 'win32' ? 4 : 12;
const INBOX_FILE_CACHE_MAX_ENTRIES = 64;
const INBOX_FILE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const INBOX_FILE_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

interface InboxFileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

interface CachedInboxFile {
  signature: InboxFileSignature;
  messages: InboxMessage[];
  estimatedBytes: number;
}

export interface InboxMessageCursor {
  timestampMs: number;
  messageId: string;
}

export interface InboxMessagesWindow {
  messages: InboxMessage[];
  truncated: boolean;
  sourceRevision: string;
  sourceMessageCount: number;
}

function buildInboxFileSignature(stat: fs.Stats): InboxFileSignature {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function inboxFileSignaturesEqual(a: InboxFileSignature, b: InboxFileSignature): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

function cloneInboxMessages(messages: readonly InboxMessage[]): InboxMessage[] {
  return structuredClone([...messages]);
}

function estimateInboxMessagesBytes(messages: readonly InboxMessage[]): number {
  return estimateCachedValueBytes(messages);
}

function requireInboxMessageId(message: InboxMessage): string {
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (messageId.length > 0) {
    return messageId;
  }
  return getEffectiveInboxMessageId(message) ?? '';
}

function compareNewestFirst(left: InboxMessage, right: InboxMessage): number {
  const rightMs = Date.parse(right.timestamp);
  const leftMs = Date.parse(left.timestamp);
  if (Number.isFinite(rightMs) && Number.isFinite(leftMs)) {
    const diff = rightMs - leftMs;
    if (diff !== 0) return diff;
  }
  return requireInboxMessageId(left).localeCompare(requireInboxMessageId(right));
}

function isMessageAfterCursor(message: InboxMessage, cursor: InboxMessageCursor | null): boolean {
  if (!cursor) {
    return true;
  }

  const messageMs = Date.parse(message.timestamp);
  if (messageMs < cursor.timestampMs) return true;
  if (messageMs > cursor.timestampMs) return false;
  if (!cursor.messageId) return false;
  return requireInboxMessageId(message).localeCompare(cursor.messageId) > 0;
}

function buildInboxSourceRevisionEntry(message: InboxMessage): string {
  return JSON.stringify([
    requireInboxMessageId(message),
    message.timestamp ?? '',
    message.from ?? '',
    message.to ?? '',
    message.source ?? '',
    message.text ?? '',
  ]);
}

function addInboxSourceRevisionEntries(
  hash: ReturnType<typeof createHash>,
  entries: string[]
): void {
  entries.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const entry of entries) {
    hash.update(entry);
    hash.update('\n');
  }
}

function normalizeInboxMessageItem(item: unknown): InboxMessage | null {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const row = item as Partial<InboxMessage>;
  if (
    typeof row.from !== 'string' ||
    typeof row.text !== 'string' ||
    typeof row.timestamp !== 'string'
  ) {
    return null;
  }
  // messageId is optional in inbox files. Teammate responses (e.g. inboxes/user.json)
  // often lack messageId because Claude Code CLI doesn't generate one.
  // We produce a deterministic hash so the same message always gets the same ID
  // across reads - important for React keys, dedup, and message tracking.
  const messageId = getEffectiveInboxMessageId(row);
  if (!messageId) {
    return null;
  }
  return {
    from: row.from,
    to: typeof row.to === 'string' ? row.to : undefined,
    text: row.text,
    timestamp: row.timestamp,
    read: typeof row.read === 'boolean' ? row.read : false,
    taskRefs: Array.isArray(row.taskRefs) ? row.taskRefs : undefined,
    actionMode:
      row.actionMode === 'do' || row.actionMode === 'ask' || row.actionMode === 'delegate'
        ? row.actionMode
        : undefined,
    commentId: typeof row.commentId === 'string' ? row.commentId : undefined,
    summary: typeof row.summary === 'string' ? row.summary : undefined,
    color: typeof row.color === 'string' ? row.color : undefined,
    messageId,
    relayOfMessageId: typeof row.relayOfMessageId === 'string' ? row.relayOfMessageId : undefined,
    source: typeof row.source === 'string' ? (row.source as InboxMessage['source']) : undefined,
    leadSessionId: typeof row.leadSessionId === 'string' ? row.leadSessionId : undefined,
    conversationId: typeof row.conversationId === 'string' ? row.conversationId : undefined,
    replyToConversationId:
      typeof row.replyToConversationId === 'string' ? row.replyToConversationId : undefined,
    attachments: Array.isArray(row.attachments) ? row.attachments : undefined,
    toolSummary: typeof row.toolSummary === 'string' ? row.toolSummary : undefined,
    toolCalls: Array.isArray(row.toolCalls)
      ? (row.toolCalls as unknown[])
          .filter(
            (tc): tc is { name: string; preview?: string } =>
              tc != null &&
              typeof tc === 'object' &&
              typeof (tc as Record<string, unknown>).name === 'string'
          )
          .map((tc) => ({
            name: tc.name,
            preview: typeof tc.preview === 'string' ? tc.preview : undefined,
          }))
      : undefined,
    messageKind:
      row.messageKind === 'slash_command' ||
      row.messageKind === 'slash_command_result' ||
      row.messageKind === 'task_comment_notification' ||
      row.messageKind === 'task_stall_remediation' ||
      row.messageKind === 'member_work_sync_nudge' ||
      row.messageKind === 'runtime_recovery_nudge' ||
      row.messageKind === 'agent_error'
        ? row.messageKind
        : row.messageKind === 'default'
          ? 'default'
          : undefined,
    agentError:
      row.agentError?.schemaVersion === 1 &&
      (row.agentError.type === 'api_error' || row.agentError.type === 'codex_native_timeout') &&
      row.agentError.phase === 'terminal' &&
      typeof row.agentError.detail === 'string' &&
      typeof row.agentError.failedMessageId === 'string' &&
      typeof row.agentError.innerRecoveryAttempts === 'number' &&
      Number.isInteger(row.agentError.innerRecoveryAttempts) &&
      row.agentError.innerRecoveryAttempts >= 0 &&
      (row.agentError.runtimeSessionId == null ||
        typeof row.agentError.runtimeSessionId === 'string') &&
      (row.agentError.bootstrapRunId == null || typeof row.agentError.bootstrapRunId === 'string')
        ? row.agentError
        : undefined,
    runtimeRecovery:
      row.runtimeRecovery?.schemaVersion === 1 &&
      typeof row.runtimeRecovery.recoveryId === 'string' &&
      typeof row.runtimeRecovery.sourceFailureId === 'string' &&
      typeof row.runtimeRecovery.attempt === 'number' &&
      Number.isInteger(row.runtimeRecovery.attempt) &&
      row.runtimeRecovery.attempt >= 1 &&
      typeof row.runtimeRecovery.reasonCode === 'string' &&
      row.runtimeRecovery.reasonCode.length > 0 &&
      typeof row.runtimeRecovery.payloadHash === 'string'
        ? row.runtimeRecovery
        : undefined,
    workSyncIntent:
      row.workSyncIntent === 'agenda_sync' || row.workSyncIntent === 'review_pickup'
        ? row.workSyncIntent
        : undefined,
    workSyncIntentKey:
      typeof row.workSyncIntentKey === 'string' ? row.workSyncIntentKey : undefined,
    workSyncReviewRequestEventIds: Array.isArray(row.workSyncReviewRequestEventIds)
      ? row.workSyncReviewRequestEventIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0
        )
      : undefined,
    workSyncPayloadHash:
      typeof row.workSyncPayloadHash === 'string' ? row.workSyncPayloadHash : undefined,
    slashCommand:
      row.slashCommand &&
      typeof row.slashCommand === 'object' &&
      typeof row.slashCommand.name === 'string' &&
      typeof row.slashCommand.command === 'string'
        ? {
            name: row.slashCommand.name,
            command: row.slashCommand.command,
            args: typeof row.slashCommand.args === 'string' ? row.slashCommand.args : undefined,
            knownDescription:
              typeof row.slashCommand.knownDescription === 'string'
                ? row.slashCommand.knownDescription
                : undefined,
          }
        : undefined,
    commandOutput:
      row.commandOutput &&
      typeof row.commandOutput === 'object' &&
      (row.commandOutput.stream === 'stdout' || row.commandOutput.stream === 'stderr') &&
      typeof row.commandOutput.commandLabel === 'string'
        ? {
            stream: row.commandOutput.stream,
            commandLabel: row.commandOutput.commandLabel,
          }
        : undefined,
  };
}

function visitInboxJsonArrayItems(raw: string, onItem: (item: unknown) => void): boolean {
  let index = 0;
  const isJsonWhitespace = (char: string | undefined): boolean =>
    char === ' ' || char === '\n' || char === '\r' || char === '\t';
  const skipWhitespace = () => {
    while (index < raw.length && isJsonWhitespace(raw[index])) {
      index += 1;
    }
  };
  const finishArray = (): boolean => {
    index += 1;
    skipWhitespace();
    return index >= raw.length;
  };

  skipWhitespace();
  if (raw[index] !== '[') {
    return false;
  }
  index += 1;

  const scanString = (): boolean => {
    if (raw[index] !== '"') {
      return false;
    }
    index += 1;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index];
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        index += 1;
        continue;
      }
      if (char === '"') {
        index += 1;
        return true;
      }
      index += 1;
    }
    return false;
  };

  const scanComposite = (): boolean => {
    let depth = 0;
    let inString = false;
    let escaped = false;

    while (index < raw.length) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        index += 1;
        continue;
      }
      if (char === '"') {
        inString = true;
        index += 1;
        continue;
      }
      if (char === '{' || char === '[') {
        depth += 1;
        index += 1;
        continue;
      }
      if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          return true;
        }
        if (depth < 0) {
          return false;
        }
      }
      index += 1;
    }

    return false;
  };

  const scanNumber = (): boolean => {
    const start = index;
    while (index < raw.length && /[-+0-9.eE]/.test(raw[index] ?? '')) {
      index += 1;
    }
    return index > start;
  };

  const scanLiteral = (literal: string): boolean => {
    if (!raw.startsWith(literal, index)) {
      return false;
    }
    index += literal.length;
    return true;
  };

  let expectingValue = true;
  let seenValue = false;
  while (index < raw.length) {
    skipWhitespace();
    if (raw[index] === ']') {
      if (expectingValue && seenValue) {
        return false;
      }
      return finishArray();
    }
    if (raw[index] === ',') {
      if (expectingValue) {
        return false;
      }
      index += 1;
      expectingValue = true;
      continue;
    }
    if (!expectingValue) {
      return false;
    }
    const start = index;
    const char = raw[index];
    const scanned =
      char === '{' || char === '['
        ? scanComposite()
        : char === '"'
          ? scanString()
          : char === 't'
            ? scanLiteral('true')
            : char === 'f'
              ? scanLiteral('false')
              : char === 'n'
                ? scanLiteral('null')
                : scanNumber();
    if (!scanned) {
      return false;
    }

    try {
      onItem(JSON.parse(raw.slice(start, index)) as unknown);
    } catch {
      return false;
    }
    seenValue = true;
    expectingValue = false;
  }

  return false;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TeamInboxReader {
  private readonly inboxFileCache = new Map<string, CachedInboxFile>();
  private inboxFileCacheBytes = 0;

  private deleteCachedMessages(inboxPath: string): void {
    const cached = this.inboxFileCache.get(inboxPath);
    if (!cached) {
      return;
    }
    this.inboxFileCacheBytes = Math.max(0, this.inboxFileCacheBytes - cached.estimatedBytes);
    this.inboxFileCache.delete(inboxPath);
  }

  private evictOldestCachedInboxFile(): boolean {
    const oldestKey = this.inboxFileCache.keys().next().value;
    if (oldestKey === undefined) {
      return false;
    }
    this.deleteCachedMessages(oldestKey);
    return true;
  }

  private trimInboxFileCache(): void {
    while (
      this.inboxFileCache.size > INBOX_FILE_CACHE_MAX_ENTRIES ||
      this.inboxFileCacheBytes > INBOX_FILE_CACHE_MAX_BYTES
    ) {
      if (!this.evictOldestCachedInboxFile()) {
        return;
      }
    }
  }

  private getCachedMessages(
    inboxPath: string,
    signature: InboxFileSignature
  ): InboxMessage[] | undefined {
    const cached = this.inboxFileCache.get(inboxPath);
    if (!cached) {
      return undefined;
    }
    if (!inboxFileSignaturesEqual(cached.signature, signature)) {
      this.deleteCachedMessages(inboxPath);
      return undefined;
    }
    this.inboxFileCache.delete(inboxPath);
    this.inboxFileCache.set(inboxPath, cached);
    return cloneInboxMessages(cached.messages);
  }

  private setCachedMessages(
    inboxPath: string,
    signature: InboxFileSignature,
    messages: readonly InboxMessage[]
  ): void {
    const estimatedBytes = estimateInboxMessagesBytes(messages);
    this.deleteCachedMessages(inboxPath);
    if (estimatedBytes > INBOX_FILE_CACHE_MAX_ENTRY_BYTES) {
      return;
    }
    this.inboxFileCache.set(inboxPath, {
      signature,
      messages: cloneInboxMessages(messages),
      estimatedBytes,
    });
    this.inboxFileCacheBytes += estimatedBytes;
    this.trimInboxFileCache();
  }

  async listInboxNames(teamName: string): Promise<string[]> {
    const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');

    let entries: string[];
    try {
      entries = await fs.promises.readdir(inboxDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return entries
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => name.replace(/\.json$/, ''))
      .filter((name) => name !== '*');
  }

  async getMessagesFor(teamName: string, member: string): Promise<InboxMessage[]> {
    const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${member}.json`);

    let raw: string;
    let signature: InboxFileSignature;
    try {
      const stat = await fs.promises.stat(inboxPath);
      // Avoid hangs on non-regular files (FIFO, sockets) and unbounded memory usage on huge files.
      if (!stat.isFile() || stat.size > MAX_INBOX_FILE_BYTES) {
        this.deleteCachedMessages(inboxPath);
        return [];
      }
      signature = buildInboxFileSignature(stat);
      const cached = this.getCachedMessages(inboxPath, signature);
      if (cached) {
        return cached;
      }
      raw = await readFileUtf8WithTimeout(inboxPath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.deleteCachedMessages(inboxPath);
        return [];
      }
      if (error instanceof FileReadTimeoutError) {
        return [];
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.setCachedMessages(inboxPath, signature, []);
      return [];
    }
    if (!Array.isArray(parsed)) {
      this.setCachedMessages(inboxPath, signature, []);
      return [];
    }

    const messages: InboxMessage[] = [];
    for (const item of parsed) {
      const message = normalizeInboxMessageItem(item);
      if (message) {
        messages.push(message);
      }
    }

    messages.sort((a, b) => {
      const bt = Date.parse(b.timestamp);
      const at = Date.parse(a.timestamp);
      if (Number.isNaN(bt) || Number.isNaN(at)) {
        return 0;
      }
      return bt - at;
    });

    this.setCachedMessages(inboxPath, signature, messages);
    return cloneInboxMessages(messages);
  }

  async getMessages(teamName: string): Promise<InboxMessage[]> {
    const members = await this.listInboxNames(teamName);
    const chunks = await mapLimit(members, INBOX_READ_CONCURRENCY, async (member) => {
      try {
        const msgs = await this.getMessagesFor(teamName, member);
        for (const msg of msgs) {
          if (!msg.to) {
            msg.to = member;
          }
        }
        return msgs;
      } catch {
        return [] as InboxMessage[];
      }
    });

    const merged = chunks.flat();
    merged.sort((a, b) => {
      const bt = Date.parse(b.timestamp);
      const at = Date.parse(a.timestamp);
      if (Number.isNaN(bt) || Number.isNaN(at)) {
        return 0;
      }
      return bt - at;
    });
    return merged;
  }

  private async getMessagesWindowFor(
    teamName: string,
    member: string,
    options: { cursor?: InboxMessageCursor | null; limit: number }
  ): Promise<InboxMessagesWindow> {
    const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${member}.json`);
    const limit = Math.max(1, Math.floor(options.limit));
    const sourceRevisionHash = createHash('sha256');
    const sourceRevisionEntries: string[] = [];
    let raw: string;

    try {
      const stat = await fs.promises.stat(inboxPath);
      if (!stat.isFile() || stat.size > MAX_INBOX_FILE_BYTES) {
        this.deleteCachedMessages(inboxPath);
        sourceRevisionHash.update(`skipped:${stat.isFile() ? 'oversized' : 'non-file'}\n`);
        return {
          messages: [],
          truncated: false,
          sourceRevision: sourceRevisionHash.digest('hex').slice(0, 24),
          sourceMessageCount: 0,
        };
      }
      const signature = buildInboxFileSignature(stat);
      const cached = this.getCachedMessages(inboxPath, signature);
      if (cached) {
        return this.buildMessagesWindowFromMessages(cached, member, options);
      }
      raw = await readFileUtf8WithTimeout(inboxPath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.deleteCachedMessages(inboxPath);
        sourceRevisionHash.update('missing\n');
        return {
          messages: [],
          truncated: false,
          sourceRevision: sourceRevisionHash.digest('hex').slice(0, 24),
          sourceMessageCount: 0,
        };
      }
      if (error instanceof FileReadTimeoutError) {
        sourceRevisionHash.update('timeout\n');
        return {
          messages: [],
          truncated: false,
          sourceRevision: sourceRevisionHash.digest('hex').slice(0, 24),
          sourceMessageCount: 0,
        };
      }
      throw error;
    }

    let sourceMessageCount = 0;
    let truncated = false;
    let windowMessages: InboxMessage[] = [];

    const parsed = visitInboxJsonArrayItems(raw, (item) => {
      const message = normalizeInboxMessageItem(item);
      if (!message) {
        return;
      }
      if (!message.to) {
        message.to = member;
      }
      sourceMessageCount += 1;
      if (!isTeamInternalControlMessageEnvelope(message)) {
        sourceRevisionEntries.push(buildInboxSourceRevisionEntry(message));
      }
      if (isMessageAfterCursor(message, options.cursor ?? null)) {
        windowMessages.push(message);
      }
      if (windowMessages.length > limit) {
        truncated = true;
        windowMessages.sort(compareNewestFirst);
        windowMessages = windowMessages.slice(0, limit);
      }
    });

    if (!parsed) {
      addInboxSourceRevisionEntries(sourceRevisionHash, sourceRevisionEntries);
      sourceRevisionHash.update('parse-error\n');
      return {
        messages: [],
        truncated: false,
        sourceRevision: sourceRevisionHash.digest('hex').slice(0, 24),
        sourceMessageCount: 0,
      };
    }

    windowMessages.sort(compareNewestFirst);
    if (windowMessages.length > limit) {
      truncated = true;
      windowMessages = windowMessages.slice(0, limit);
    }
    addInboxSourceRevisionEntries(sourceRevisionHash, sourceRevisionEntries);

    return {
      messages: windowMessages,
      truncated,
      sourceRevision: sourceRevisionHash.digest('hex').slice(0, 24),
      sourceMessageCount,
    };
  }

  private buildMessagesWindowFromMessages(
    messages: InboxMessage[],
    member: string,
    options: { cursor?: InboxMessageCursor | null; limit: number }
  ): InboxMessagesWindow {
    const limit = Math.max(1, Math.floor(options.limit));
    const sourceRevisionHash = createHash('sha256');
    const sourceRevisionEntries: string[] = [];
    let truncated = false;
    let windowMessages: InboxMessage[] = [];

    for (const message of messages) {
      if (!message.to) {
        message.to = member;
      }
      if (!isTeamInternalControlMessageEnvelope(message)) {
        sourceRevisionEntries.push(buildInboxSourceRevisionEntry(message));
      }
      if (isMessageAfterCursor(message, options.cursor ?? null)) {
        windowMessages.push(message);
      }
      if (windowMessages.length > limit) {
        truncated = true;
        windowMessages.sort(compareNewestFirst);
        windowMessages = windowMessages.slice(0, limit);
      }
    }

    windowMessages.sort(compareNewestFirst);
    if (windowMessages.length > limit) {
      truncated = true;
      windowMessages = windowMessages.slice(0, limit);
    }
    addInboxSourceRevisionEntries(sourceRevisionHash, sourceRevisionEntries);

    return {
      messages: windowMessages,
      truncated,
      sourceRevision: sourceRevisionHash.digest('hex').slice(0, 24),
      sourceMessageCount: messages.length,
    };
  }

  async getMessagesWindow(
    teamName: string,
    options: { cursor?: InboxMessageCursor | null; limit: number }
  ): Promise<InboxMessagesWindow> {
    const members = (await this.listInboxNames(teamName)).sort((left, right) =>
      left.localeCompare(right)
    );
    const limit = Math.max(1, Math.floor(options.limit));
    const sourceRevisionHash = createHash('sha256');
    sourceRevisionHash.update(`members:${members.join('\0')}\n`);

    let sourceMessageCount = 0;
    let truncated = false;
    let windowMessages: InboxMessage[] = [];

    for (const member of members) {
      let memberWindow: InboxMessagesWindow;
      try {
        memberWindow = await this.getMessagesWindowFor(teamName, member, {
          cursor: options.cursor ?? null,
          limit,
        });
      } catch {
        continue;
      }

      sourceRevisionHash.update(
        `member:${member}:${memberWindow.sourceMessageCount}:${memberWindow.sourceRevision}\n`
      );
      sourceMessageCount += memberWindow.sourceMessageCount;
      if (memberWindow.truncated) {
        truncated = true;
      }

      windowMessages.push(...memberWindow.messages);

      if (windowMessages.length > limit) {
        truncated = true;
        windowMessages.sort(compareNewestFirst);
        windowMessages = windowMessages.slice(0, limit);
      }
    }

    windowMessages.sort(compareNewestFirst);
    if (windowMessages.length > limit) {
      truncated = true;
      windowMessages = windowMessages.slice(0, limit);
    }

    return {
      messages: windowMessages,
      truncated,
      sourceRevision: sourceRevisionHash.digest('hex').slice(0, 24),
      sourceMessageCount,
    };
  }
}
