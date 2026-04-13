import { describeBoardTaskActivityLabel } from '@shared/utils/boardTaskActivityLabels';
import { createLogger } from '@shared/utils/logger';
import { createHash } from 'crypto';

import type { BoardTaskActivityRecord } from '../activity/BoardTaskActivityRecord';
import type {
  BoardTaskExactLogAnchor,
  BoardTaskExactLogBundleCandidate,
  BoardTaskExactLogFileVersion,
} from './BoardTaskExactLogTypes';

const logger = createLogger('Service:BoardTaskExactLogSummarySelector');

function noteExactDiagnostic(
  event: string,
  details: Record<string, string | number | undefined> = {}
): void {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

  logger.debug(`[board_task_exact_logs.${event}]${suffix ? ` ${suffix}` : ''}`);
}

function compareCandidateTimestamps(
  left: BoardTaskActivityRecord,
  right: BoardTaskActivityRecord
): number {
  const leftTs = Date.parse(left.timestamp);
  const rightTs = Date.parse(right.timestamp);
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
    return leftTs - rightTs;
  }
  if (left.source.sourceOrder !== right.source.sourceOrder) {
    return left.source.sourceOrder - right.source.sourceOrder;
  }
  return left.id.localeCompare(right.id);
}

function buildMessageGroupKey(record: BoardTaskActivityRecord): string {
  return `${record.source.filePath}:${record.source.messageUuid}`;
}

function buildToolAnchor(
  filePath: string,
  messageUuid: string,
  toolUseId: string
): BoardTaskExactLogAnchor {
  return {
    kind: 'tool',
    filePath,
    messageUuid,
    toolUseId,
  };
}

function buildMessageAnchor(filePath: string, messageUuid: string): BoardTaskExactLogAnchor {
  return {
    kind: 'message',
    filePath,
    messageUuid,
  };
}

function anchorId(anchor: BoardTaskExactLogAnchor): string {
  return anchor.kind === 'tool'
    ? `tool:${anchor.filePath}:${anchor.toolUseId ?? ''}`
    : `message:${anchor.filePath}:${anchor.messageUuid}`;
}

function sourceGenerationFor(
  anchor: BoardTaskExactLogAnchor,
  version: BoardTaskExactLogFileVersion | undefined
): string | null {
  if (!version) return null;
  const hash = createHash('sha256');
  hash.update(anchor.filePath);
  hash.update('\0');
  hash.update(String(version.size));
  hash.update('\0');
  hash.update(String(version.mtimeMs));
  return hash.digest('hex');
}

function chooseSummaryRecord(
  records: BoardTaskActivityRecord[],
  anchor: BoardTaskExactLogAnchor
): BoardTaskActivityRecord | null {
  if (records.length === 0) {
    return null;
  }

  const anchoredRecords =
    anchor.kind === 'tool' && anchor.toolUseId
      ? records.filter(
          (record) =>
            record.source.toolUseId === anchor.toolUseId ||
            record.action?.toolUseId === anchor.toolUseId
        )
      : records;
  const candidates = anchoredRecords.length > 0 ? anchoredRecords : records;

  return (
    candidates.find((record) => record.action?.canonicalToolName) ??
    candidates.find((record) => record.linkKind !== 'execution' && record.action) ??
    candidates[0] ??
    null
  );
}

export class BoardTaskExactLogSummarySelector {
  selectSummaries(args: {
    records: BoardTaskActivityRecord[];
    fileVersionsByPath: Map<string, BoardTaskExactLogFileVersion>;
  }): BoardTaskExactLogBundleCandidate[] {
    const byMessage = new Map<string, BoardTaskActivityRecord[]>();
    for (const record of args.records) {
      const key = buildMessageGroupKey(record);
      const bucket = byMessage.get(key) ?? [];
      bucket.push(record);
      byMessage.set(key, bucket);
    }

    const groups = new Map<
      string,
      { anchor: BoardTaskExactLogAnchor; records: BoardTaskActivityRecord[] }
    >();

    for (const messageRecords of byMessage.values()) {
      const sortedMessageRecords = [...messageRecords].sort(compareCandidateTimestamps);
      const toolUseIds = [
        ...new Set(sortedMessageRecords.map((record) => record.source.toolUseId).filter(Boolean)),
      ] as string[];
      const singleToolUseId = toolUseIds.length === 1 ? toolUseIds[0] : null;

      for (const record of sortedMessageRecords) {
        let anchor: BoardTaskExactLogAnchor;
        if (record.source.toolUseId) {
          anchor = buildToolAnchor(
            record.source.filePath,
            record.source.messageUuid,
            record.source.toolUseId
          );
        } else if (singleToolUseId) {
          anchor = buildToolAnchor(
            record.source.filePath,
            record.source.messageUuid,
            singleToolUseId
          );
        } else {
          anchor = buildMessageAnchor(record.source.filePath, record.source.messageUuid);
        }

        const key = anchorId(anchor);
        const existing = groups.get(key);
        if (existing) {
          existing.records.push(record);
        } else {
          groups.set(key, { anchor, records: [record] });
        }
      }
    }

    const candidates: BoardTaskExactLogBundleCandidate[] = [];

    for (const [key, group] of groups) {
      const sortedRecords = [...group.records].sort(compareCandidateTimestamps);
      const primaryRecord = sortedRecords[0];
      if (!primaryRecord) {
        continue;
      }

      const linkKinds = [...new Set(sortedRecords.map((record) => record.linkKind))];
      const targetRoles = [...new Set(sortedRecords.map((record) => record.targetRole))];
      const fileVersion = args.fileVersionsByPath.get(primaryRecord.source.filePath);
      const sourceGeneration = sourceGenerationFor(group.anchor, fileVersion);
      const summaryRecord = chooseSummaryRecord(sortedRecords, group.anchor) ?? primaryRecord;
      const actionLabel = describeBoardTaskActivityLabel(summaryRecord);

      const baseCandidate = {
        id: key,
        timestamp: primaryRecord.timestamp,
        actor: primaryRecord.actor,
        source: {
          filePath: primaryRecord.source.filePath,
          messageUuid: primaryRecord.source.messageUuid,
          ...(group.anchor.kind === 'tool' && group.anchor.toolUseId
            ? { toolUseId: group.anchor.toolUseId }
            : {}),
          sourceOrder: primaryRecord.source.sourceOrder,
        },
        records: sortedRecords,
        anchor: group.anchor,
        actionLabel,
        ...(summaryRecord.action?.category
          ? { actionCategory: summaryRecord.action.category }
          : {}),
        ...(summaryRecord.action?.canonicalToolName
          ? { canonicalToolName: summaryRecord.action.canonicalToolName }
          : {}),
        linkKinds,
        targetRoles,
      };

      if (sourceGeneration) {
        candidates.push({
          ...baseCandidate,
          canLoadDetail: true,
          sourceGeneration,
        });
      } else {
        noteExactDiagnostic('non_expandable_summary', {
          filePath: primaryRecord.source.filePath,
          toolUseId: group.anchor.toolUseId,
        });
        candidates.push({
          ...baseCandidate,
          canLoadDetail: false,
        });
      }
    }

    return candidates;
  }
}
