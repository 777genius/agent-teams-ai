import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { getEffectiveInboxMessageId } from './inboxMessageIdentity';

import type { InboxMessage } from '@shared/types';

const MAX_INBOX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — skip corrupt/oversized inbox files
const INBOX_READ_CONCURRENCY = process.platform === 'win32' ? 4 : 12;
const INBOX_FILE_CACHE_MAX_ENTRIES = 1_024;

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

  private getCachedMessages(
    inboxPath: string,
    signature: InboxFileSignature
  ): InboxMessage[] | undefined {
    const cached = this.inboxFileCache.get(inboxPath);
    if (!cached) {
      return undefined;
    }
    if (!inboxFileSignaturesEqual(cached.signature, signature)) {
      this.inboxFileCache.delete(inboxPath);
      return undefined;
    }
    return cloneInboxMessages(cached.messages);
  }

  private setCachedMessages(
    inboxPath: string,
    signature: InboxFileSignature,
    messages: readonly InboxMessage[]
  ): void {
    if (
      !this.inboxFileCache.has(inboxPath) &&
      this.inboxFileCache.size >= INBOX_FILE_CACHE_MAX_ENTRIES
    ) {
      const oldestKey = this.inboxFileCache.keys().next().value;
      if (oldestKey) {
        this.inboxFileCache.delete(oldestKey);
      }
    }
    this.inboxFileCache.set(inboxPath, {
      signature,
      messages: cloneInboxMessages(messages),
    });
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
        this.inboxFileCache.delete(inboxPath);
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
        this.inboxFileCache.delete(inboxPath);
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
      if (!item || typeof item !== 'object') {
        continue;
      }
      const row = item as Partial<InboxMessage>;
      if (
        typeof row.from !== 'string' ||
        typeof row.text !== 'string' ||
        typeof row.timestamp !== 'string'
      ) {
        continue;
      }
      // messageId is optional in inbox files. Teammate responses (e.g. inboxes/user.json)
      // often lack messageId because Claude Code CLI doesn't generate one.
      // We produce a deterministic hash so the same message always gets the same ID
      // across reads — important for React keys, dedup, and message tracking.
      const messageId = getEffectiveInboxMessageId(row);
      if (!messageId) {
        continue;
      }
      messages.push({
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
        relayOfMessageId:
          typeof row.relayOfMessageId === 'string' ? row.relayOfMessageId : undefined,
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
          row.messageKind === 'agent_error'
            ? row.messageKind
            : row.messageKind === 'default'
              ? 'default'
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
      });
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
}
