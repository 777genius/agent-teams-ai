import { withFileLock } from '@main/services/team/fileLock';
import { renamePathWithRetry } from '@main/utils/atomicWrite';
import { appendFile, mkdir, rm, stat } from 'fs/promises';
import { dirname } from 'path';

import type {
  MemberWorkSyncAuditEvent,
  MemberWorkSyncAuditJournalPort,
  MemberWorkSyncLoggerPort,
} from '../../core/application';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ROTATED_FILE_COUNT = 5;
const MAX_PREVIEW_CHARS = 240;
const MAX_DIAGNOSTICS = 20;
const MAX_TRIGGER_REASONS = 20;
const MAX_TASK_REFS = 20;
const MAX_SHORT_FIELD_CHARS = 240;

interface PersistedAuditEvent extends MemberWorkSyncAuditEvent {
  schemaVersion: 1;
}

export interface FileMemberWorkSyncAuditJournalOptions {
  maxBytes?: number;
  rotatedFileCount?: number;
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function sanitizeMetadata(
  metadata: MemberWorkSyncAuditEvent['metadata']
): MemberWorkSyncAuditEvent['metadata'] {
  if (!metadata) {
    return undefined;
  }
  const sanitized = Object.create(null) as NonNullable<MemberWorkSyncAuditEvent['metadata']>;
  for (const [key, value] of Object.entries(metadata)) {
    sanitized[truncateText(key, MAX_SHORT_FIELD_CHARS)] =
      typeof value === 'string' ? truncateText(value, MAX_SHORT_FIELD_CHARS) : value;
  }
  return sanitized;
}

function sanitizeTaskRefs(
  taskRefs: MemberWorkSyncAuditEvent['taskRefs']
): MemberWorkSyncAuditEvent['taskRefs'] {
  return taskRefs?.slice(0, MAX_TASK_REFS).map((taskRef) => ({
    taskId: truncateText(taskRef.taskId, MAX_SHORT_FIELD_CHARS),
    ...(taskRef.displayId
      ? { displayId: truncateText(taskRef.displayId, MAX_SHORT_FIELD_CHARS) }
      : {}),
    ...(taskRef.teamName
      ? { teamName: truncateText(taskRef.teamName, MAX_SHORT_FIELD_CHARS) }
      : {}),
  }));
}

function sanitizeEvent(event: MemberWorkSyncAuditEvent): PersistedAuditEvent {
  return {
    ...event,
    schemaVersion: 1,
    source: truncateText(event.source, MAX_SHORT_FIELD_CHARS),
    ...(event.reason ? { reason: truncateText(event.reason, MAX_SHORT_FIELD_CHARS) } : {}),
    ...(event.providerId
      ? { providerId: truncateText(event.providerId, MAX_SHORT_FIELD_CHARS) }
      : {}),
    ...(event.state ? { state: truncateText(event.state, MAX_SHORT_FIELD_CHARS) } : {}),
    ...(event.agendaFingerprint
      ? { agendaFingerprint: truncateText(event.agendaFingerprint, MAX_SHORT_FIELD_CHARS) }
      : {}),
    ...(typeof event.messagePreview === 'string'
      ? { messagePreview: truncateText(event.messagePreview, MAX_PREVIEW_CHARS) }
      : {}),
    ...(event.diagnostics
      ? {
          diagnostics: event.diagnostics
            .slice(0, MAX_DIAGNOSTICS)
            .map((diagnostic) => truncateText(diagnostic, MAX_SHORT_FIELD_CHARS)),
        }
      : {}),
    ...(event.triggerReasons
      ? {
          triggerReasons: event.triggerReasons
            .slice(0, MAX_TRIGGER_REASONS)
            .map((reason) => truncateText(reason, MAX_SHORT_FIELD_CHARS)),
        }
      : {}),
    ...(event.taskRefs ? { taskRefs: sanitizeTaskRefs(event.taskRefs) } : {}),
    ...(event.metadata ? { metadata: sanitizeMetadata(event.metadata) } : {}),
  };
}

function rotatedPath(filePath: string, index: number): string {
  return `${filePath}.${index}`;
}

async function rotateIfNeeded(
  filePath: string,
  maxBytes: number,
  rotatedFileCount: number
): Promise<void> {
  const current = await stat(filePath).catch(() => null);
  if (!current?.isFile() || current.size < maxBytes) {
    return;
  }

  await rm(rotatedPath(filePath, rotatedFileCount), { force: true }).catch(() => undefined);
  for (let index = rotatedFileCount - 1; index >= 1; index -= 1) {
    await renamePathWithRetry(rotatedPath(filePath, index), rotatedPath(filePath, index + 1)).catch(
      () => undefined
    );
  }
  await renamePathWithRetry(filePath, rotatedPath(filePath, 1)).catch(() => undefined);
}

export class NoopMemberWorkSyncAuditJournal implements MemberWorkSyncAuditJournalPort {
  async append(): Promise<void> {
    // Intentionally empty.
  }
}

export class FileMemberWorkSyncAuditJournal implements MemberWorkSyncAuditJournalPort {
  private readonly maxBytes: number;
  private readonly rotatedFileCount: number;
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(
    private readonly paths: MemberWorkSyncStorePaths,
    private readonly logger?: MemberWorkSyncLoggerPort,
    options: FileMemberWorkSyncAuditJournalOptions = {}
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.rotatedFileCount = options.rotatedFileCount ?? DEFAULT_ROTATED_FILE_COUNT;
  }

  async append(event: MemberWorkSyncAuditEvent): Promise<void> {
    const filePath = this.paths.getMemberJournalPath(event.teamName, event.memberName);
    const previous = this.appendChains.get(filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.appendToFile(filePath, event));

    this.appendChains.set(filePath, next);

    try {
      await next;
    } finally {
      if (this.appendChains.get(filePath) === next) {
        this.appendChains.delete(filePath);
      }
    }
  }

  private async appendToFile(filePath: string, event: MemberWorkSyncAuditEvent): Promise<void> {
    try {
      await this.paths.ensureMemberWorkSyncDir(event.teamName, event.memberName);
      await mkdir(dirname(filePath), { recursive: true });
      await withFileLock(filePath, async () => {
        await rotateIfNeeded(filePath, this.maxBytes, this.rotatedFileCount);
        await appendFile(filePath, `${JSON.stringify(sanitizeEvent(event))}\n`, 'utf8');
      });
    } catch (error) {
      this.logger?.warn('member work sync audit journal append failed', {
        teamName: event.teamName,
        memberName: event.memberName,
        event: event.event,
        error: String(error),
      });
    }
  }
}
