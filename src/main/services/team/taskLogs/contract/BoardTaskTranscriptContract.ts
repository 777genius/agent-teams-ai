import { createLogger } from '@shared/utils/logger';

import type {
  BoardTaskActivityLinkKind,
  BoardTaskActivityPhase,
  BoardTaskActivityTargetRole,
  BoardTaskActorRelation,
  BoardTaskLocator,
} from '@shared/types';

const logger = createLogger('Service:BoardTaskTranscriptContract');

export interface ParsedBoardTaskActorContext {
  relation: BoardTaskActorRelation;
  activeTask?: BoardTaskLocator;
  activePhase?: BoardTaskActivityPhase;
  activeExecutionSeq?: number;
}

export interface ParsedBoardTaskLink {
  schemaVersion: 1;
  toolUseId?: string;
  task: BoardTaskLocator;
  targetRole: BoardTaskActivityTargetRole;
  linkKind: BoardTaskActivityLinkKind;
  taskArgumentSlot?: 'taskId' | 'targetId';
  actorContext: ParsedBoardTaskActorContext;
}

export interface ParsedBoardTaskToolAction {
  schemaVersion: 1;
  toolUseId: string;
  canonicalToolName: string;
  input?: {
    status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
    owner?: string | null;
    clarification?: 'lead' | 'user' | null;
    reviewer?: string;
    relationship?: 'blocked-by' | 'blocks' | 'related';
    commentId?: string;
  };
  resultRefs?: {
    commentId?: string;
    attachmentId?: string;
    filename?: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseNullableOwner(value: unknown): string | null | undefined {
  if (value === null) return null;
  const normalized = asNonEmptyString(value);
  if (!normalized) return undefined;
  if (normalized === 'clear' || normalized === 'none') {
    return null;
  }
  return normalized;
}

function parseStatus(
  value: unknown
): 'pending' | 'in_progress' | 'completed' | 'deleted' | undefined {
  const normalized = asNonEmptyString(value);
  if (
    normalized === 'pending' ||
    normalized === 'in_progress' ||
    normalized === 'completed' ||
    normalized === 'deleted'
  ) {
    return normalized;
  }
  return undefined;
}

function parseRelationship(value: unknown): 'blocked-by' | 'blocks' | 'related' | undefined {
  const normalized = asNonEmptyString(value);
  if (normalized === 'blocked-by' || normalized === 'blocks' || normalized === 'related') {
    return normalized;
  }
  return undefined;
}

function parseClarification(value: unknown): 'lead' | 'user' | null | undefined {
  if (value === null) return null;
  const normalized = asNonEmptyString(value);
  if (!normalized) return undefined;
  if (normalized === 'lead' || normalized === 'user') {
    return normalized;
  }
  if (normalized === 'clear') {
    return null;
  }
  return undefined;
}

function noteReadDiagnostic(
  event: string,
  details: Record<string, string | number | undefined> = {}
): void {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

  logger.debug(`[board_task_activity.${event}]${suffix ? ` ${suffix}` : ''}`);
}

function parseSchemaVersion(record: Record<string, unknown>): 1 | null {
  if (record.schemaVersion === 1) {
    return 1;
  }
  if (record.version === 1) {
    return 1;
  }
  return null;
}

export function parseBoardTaskLocator(value: unknown): BoardTaskLocator | null {
  const record = asRecord(value);
  if (!record) return null;

  const ref = asNonEmptyString(record.ref);
  const refKind = asNonEmptyString(record.refKind);
  if (!ref || (refKind !== 'canonical' && refKind !== 'display' && refKind !== 'unknown')) {
    return null;
  }

  const canonicalId = asNonEmptyString(record.canonicalId);
  return {
    ref,
    refKind,
    ...(canonicalId ? { canonicalId } : {}),
  };
}

function parseActorContext(value: unknown): ParsedBoardTaskActorContext | null {
  const record = asRecord(value);
  if (!record) return null;

  const relation = asNonEmptyString(record.relation);
  if (
    relation !== 'same_task' &&
    relation !== 'other_active_task' &&
    relation !== 'idle' &&
    relation !== 'ambiguous'
  ) {
    return null;
  }

  const activeTask = parseBoardTaskLocator(record.activeTask);
  const activePhase = asNonEmptyString(record.activePhase);
  const activeExecutionSeq =
    typeof record.activeExecutionSeq === 'number' && Number.isFinite(record.activeExecutionSeq)
      ? record.activeExecutionSeq
      : undefined;

  if (relation !== 'other_active_task') {
    return { relation };
  }

  return {
    relation,
    ...(activeTask ? { activeTask } : {}),
    ...(activePhase === 'work' || activePhase === 'review' ? { activePhase } : {}),
    ...(activeExecutionSeq ? { activeExecutionSeq } : {}),
  };
}

export function parseBoardTaskLinks(value: unknown): ParsedBoardTaskLink[] {
  if (!Array.isArray(value)) return [];

  const parsed: ParsedBoardTaskLink[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) {
      noteReadDiagnostic('link_parse_dropped', { reason: 'not_object' });
      continue;
    }

    const schemaVersion = parseSchemaVersion(record);
    if (schemaVersion !== 1) {
      noteReadDiagnostic('link_parse_dropped', { reason: 'unsupported_version' });
      continue;
    }

    const task = parseBoardTaskLocator(record.task);
    const targetRole = asNonEmptyString(record.targetRole);
    const linkKind = asNonEmptyString(record.linkKind);
    const actorContext = parseActorContext(record.actorContext);
    const rawTaskArgumentSlot = asNonEmptyString(record.taskArgumentSlot);
    const taskArgumentSlot =
      rawTaskArgumentSlot === 'taskId' || rawTaskArgumentSlot === 'targetId'
        ? rawTaskArgumentSlot
        : undefined;
    const toolUseId = asNonEmptyString(record.toolUseId);

    if (!task) {
      noteReadDiagnostic('link_parse_dropped', { reason: 'invalid_task' });
      continue;
    }
    if (!actorContext) {
      noteReadDiagnostic('link_parse_dropped', { reason: 'invalid_actor_context' });
      continue;
    }
    if (targetRole !== 'subject' && targetRole !== 'related') {
      noteReadDiagnostic('link_parse_dropped', { reason: 'invalid_target_role' });
      continue;
    }
    if (linkKind !== 'execution' && linkKind !== 'lifecycle' && linkKind !== 'board_action') {
      noteReadDiagnostic('link_parse_dropped', { reason: 'invalid_link_kind' });
      continue;
    }
    const sanitizedToolUseId = toolUseId;
    const sanitizedTaskArgumentSlot = linkKind === 'execution' ? undefined : taskArgumentSlot;

    parsed.push({
      schemaVersion: 1,
      task,
      targetRole,
      linkKind,
      actorContext,
      ...(sanitizedToolUseId ? { toolUseId: sanitizedToolUseId } : {}),
      ...(sanitizedTaskArgumentSlot ? { taskArgumentSlot: sanitizedTaskArgumentSlot } : {}),
    });
  }

  return parsed;
}

export function parseBoardTaskToolActions(value: unknown): ParsedBoardTaskToolAction[] {
  if (!Array.isArray(value)) return [];

  const parsed: ParsedBoardTaskToolAction[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) {
      noteReadDiagnostic('action_parse_dropped', { reason: 'not_object' });
      continue;
    }
    if (parseSchemaVersion(record) !== 1) {
      noteReadDiagnostic('action_parse_dropped', { reason: 'unsupported_version' });
      continue;
    }

    const toolUseId = asNonEmptyString(record.toolUseId);
    const canonicalToolName = asNonEmptyString(record.canonicalToolName);
    if (!toolUseId || !canonicalToolName) {
      noteReadDiagnostic('action_parse_dropped', { reason: 'missing_identity' });
      continue;
    }

    const inputRecord = asRecord(record.input);
    const resultRefsRecord = asRecord(record.resultRefs);

    parsed.push({
      schemaVersion: 1,
      toolUseId,
      canonicalToolName,
      ...(inputRecord
        ? {
            input: {
              ...(parseStatus(inputRecord.status) !== undefined
                ? { status: parseStatus(inputRecord.status) }
                : {}),
              ...(parseNullableOwner(inputRecord.owner) !== undefined
                ? { owner: parseNullableOwner(inputRecord.owner) }
                : {}),
              ...(parseClarification(inputRecord.clarification) !== undefined
                ? { clarification: parseClarification(inputRecord.clarification) }
                : {}),
              ...(asNonEmptyString(inputRecord.reviewer)
                ? { reviewer: asNonEmptyString(inputRecord.reviewer) }
                : {}),
              ...(parseRelationship(inputRecord.relationship) !== undefined
                ? { relationship: parseRelationship(inputRecord.relationship) }
                : {}),
              ...(asNonEmptyString(inputRecord.commentId)
                ? { commentId: asNonEmptyString(inputRecord.commentId) }
                : {}),
            },
          }
        : {}),
      ...(resultRefsRecord
        ? {
            resultRefs: {
              ...(asNonEmptyString(resultRefsRecord.commentId)
                ? { commentId: asNonEmptyString(resultRefsRecord.commentId) }
                : {}),
              ...(asNonEmptyString(resultRefsRecord.attachmentId)
                ? { attachmentId: asNonEmptyString(resultRefsRecord.attachmentId) }
                : {}),
              ...(asNonEmptyString(resultRefsRecord.filename)
                ? { filename: asNonEmptyString(resultRefsRecord.filename) }
                : {}),
            },
          }
        : {}),
    });
  }

  return parsed;
}
