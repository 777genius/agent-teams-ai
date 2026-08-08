import { validateTaskRefs } from '@main/ipc/validation/taskRefs';
import { KANBAN_COLUMN_IDS } from '@shared/constants/kanban';

import type { KanbanColumnId, UpdateKanbanPatch } from '@shared/types';

interface ValidationSuccess<T> {
  valid: true;
  value: T;
}

interface ValidationFailure {
  valid: false;
  error: string;
}

export function isUpdateKanbanPatch(value: unknown): value is UpdateKanbanPatch {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const patch = value as Partial<UpdateKanbanPatch> & { op?: unknown; column?: unknown };
  if (patch.op === 'remove') {
    return true;
  }

  if (patch.op === 'request_changes') {
    return (
      (patch.comment === undefined || typeof patch.comment === 'string') &&
      validateTaskRefs((patch as { taskRefs?: unknown }).taskRefs).valid
    );
  }

  return patch.op === 'set_column' && (patch.column === 'review' || patch.column === 'approved');
}

export function validateKanbanColumnId(
  value: unknown
): ValidationSuccess<KanbanColumnId> | ValidationFailure {
  if (typeof value !== 'string' || !KANBAN_COLUMN_IDS.includes(value as KanbanColumnId)) {
    return { valid: false, error: `columnId must be one of: ${KANBAN_COLUMN_IDS.join(', ')}` };
  }
  return { valid: true, value: value as KanbanColumnId };
}

export function isValidStoredAttachmentMimeType(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return false;
  if (normalized.length > 200) return false;
  if (normalized.includes('\0') || /[\r\n]/.test(normalized)) return false;
  const slash = normalized.indexOf('/');
  return slash > 0 && slash < normalized.length - 1;
}
