import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';

const MAX_PAGE_BYTES = 384 * 1024;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

/** Collections which can legitimately grow inside a single retained task. */
const TASK_TEXT_FIELDS = ['description', 'prompt'] as const;
const TASK_ARRAY_FIELDS = [
  'comments', 'historyEvents', 'workIntervals', 'reviewIntervals',
  'attachments', 'descriptionTaskRefs', 'promptTaskRefs',
  'blocks', 'blockedBy', 'related',
] as const;

type CommentPart = { index: number; part: number; total: number };
type SubjectPart = { part: number; total: number };
type TaskPart = {
  index: number; part: number; total: number;
  commentPart?: CommentPart; historyPart?: CommentPart; subjectPart?: SubjectPart;
};
type Segment =
  | { kind: 'task'; value: JsonValue; part: TaskPart }
  | { kind: 'message'; value: JsonValue; part: TaskPart }
  | { kind: 'process' | 'reviewer'; value: JsonValue }
  | { kind: 'kanban-task' | 'column-order'; key: string; value: JsonValue };

/** Split retained array history into valid task records, not opaque unprojected JSON.
 * Each part still passes projectTeamTask's existing allowlist before reaching the UI.
 */
function taskSegments(tasks: JsonValue[], itemBudget: number): Segment[] {
  const segments: Segment[] = [];
  for (const [index, value] of tasks.entries()) {
    if (Buffer.byteLength(JSON.stringify(value)) + 2 <= itemBudget) {
      segments.push({ kind: 'task', value, part: { index, part: 0, total: 1 } });
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TeamOwnerError('hold');
    const task = value as Record<string, JsonValue>;
    const { id, subject: originalSubject, status } = task;
    if (typeof id !== 'string' || typeof originalSubject !== 'string' || typeof status !== 'string')
      throw new TeamOwnerError('hold');
    // A repeated title must not consume nearly the whole page and turn an
    // otherwise bounded description/comment into more than 128 continuations.
    const subjectBudget = Math.min(16 * 1024, Math.floor(
      (itemBudget - Buffer.byteLength(JSON.stringify({ id, subject: '', status })) - 64) / 4
    ));
    const splitSubject = Buffer.byteLength(JSON.stringify(originalSubject)) - 2 > subjectBudget;
    const subject = splitSubject ? '' : originalSubject;
    const base: Record<string, JsonValue> = { ...task, subject };
    const parts: {
      value: JsonValue; commentPart?: CommentPart; historyPart?: CommentPart; subjectPart?: SubjectPart;
    }[] = [{ value: base }];
    if (splitSubject) {
      const envelope = { id, subject: '', status };
      const chunks = splitText(originalSubject, subjectBudget);
      for (const [part, text] of chunks.entries())
        parts.push({ value: { ...envelope, subject: text },
          subjectPart: { part, total: chunks.length } });
    }
    for (const field of TASK_ARRAY_FIELDS) {
      const items = task[field];
      if (!Array.isArray(items)) continue;
      base[field] = [];
      for (const [itemIndex, item] of items.entries()) {
        const fragment = { id, subject, status, [field]: [item] };
        if ((field !== 'comments' && field !== 'historyEvents') ||
            Buffer.byteLength(JSON.stringify(fragment)) + 64 <= itemBudget) {
          parts.push({ value: fragment });
          continue;
        }
        // A comment or review note can exceed one page. Keep its exact identity
        // and metadata while splitting only its original text.
        if (!item || typeof item !== 'object' || Array.isArray(item))
          throw new TeamOwnerError('hold');
        const itemRow = item as Record<string, JsonValue>;
        const textField = field === 'comments' ? 'text' : 'note';
        const itemText = itemRow[textField];
        if (typeof itemText !== 'string') throw new TeamOwnerError('hold');
        const envelope = { id, subject, status, [field]: [{ ...itemRow, [textField]: '' }] };
        const maxTextBytes = itemBudget - Buffer.byteLength(JSON.stringify(envelope)) - 64;
        if (maxTextBytes <= 0) throw new TeamOwnerError('hold');
        const chunks: string[] = [];
        let chunk = '', bytes = 0;
        for (const character of itemText) {
          const size = Buffer.byteLength(JSON.stringify(character)) - 2;
          if (size > maxTextBytes) throw new TeamOwnerError('hold');
          if (bytes + size > maxTextBytes) {
            chunks.push(chunk);
            chunk = '';
            bytes = 0;
          }
          chunk += character;
          bytes += size;
        }
        chunks.push(chunk);
        for (const [part, text] of chunks.entries()) {
          parts.push({
            value: { id, subject, status, [field]: [{ ...itemRow, [textField]: text }] },
            [field === 'comments' ? 'commentPart' : 'historyPart']:
              { index: itemIndex, part, total: chunks.length },
          });
        }
      }
    }
    // Projected text fields may be larger than the MCP or Desktop page budget.
    // Keep each fragment a valid task projection and reassemble only after all
    // original signed pages have been received.
    for (const field of TASK_TEXT_FIELDS) {
      const value = task[field];
      if (typeof value !== 'string') continue;
      base[field] = '';
      if (!value) continue;
      const envelope = { id, subject, status, [field]: '' };
      const maxBytes = itemBudget - Buffer.byteLength(JSON.stringify(envelope)) - 64;
      if (maxBytes <= 0) throw new TeamOwnerError('hold');
      let chunk = '', bytes = 0;
      for (const character of value) {
        const size = Buffer.byteLength(JSON.stringify(character)) - 2;
        if (size > maxBytes) throw new TeamOwnerError('hold');
        if (bytes + size > maxBytes) {
          parts.push({ value: { ...envelope, [field]: chunk } });
          chunk = '';
          bytes = 0;
        }
        chunk += character;
        bytes += size;
      }
      if (chunk) parts.push({ value: { ...envelope, [field]: chunk } });
    }
    const sourceMessage = task.sourceMessage;
    if (sourceMessage && typeof sourceMessage === 'object' && !Array.isArray(sourceMessage)) {
      const original = sourceMessage as Record<string, JsonValue>;
      if (typeof task.sourceMessageId !== 'string' || typeof original.text !== 'string' ||
          typeof original.from !== 'string' || typeof original.timestamp !== 'string')
        throw new TeamOwnerError('hold');
      // Source attachment provenance stays on the base. Continuations contain
      // only original identity and text, projected by Main like the base.
      base.sourceMessage = { ...original, text: '' };
      const envelope = { id, subject, status, sourceMessageId: task.sourceMessageId,
        sourceMessage: { from: original.from, timestamp: original.timestamp,
          ...(original.source === undefined ? {} : { source: original.source }), text: '' } };
      const maxTextBytes = itemBudget - Buffer.byteLength(JSON.stringify(envelope)) - 64;
      if (original.text) for (const text of splitText(original.text, maxTextBytes))
        parts.push({ value: { ...envelope, sourceMessage: { ...envelope.sourceMessage, text } } });
    }
    // An unsupported oversized nested item still fails closed without data loss.
    if (parts.length === 1 || parts.some(({ value }) =>
      Buffer.byteLength(JSON.stringify(value)) + 64 > itemBudget
    )) throw new TeamOwnerError('hold');
    for (const [part, fragment] of parts.entries())
      segments.push({ kind: 'task', value: fragment.value,
        part: { index, part, total: parts.length,
          ...(fragment.commentPart ? { commentPart: fragment.commentPart } : {}),
          ...(fragment.historyPart ? { historyPart: fragment.historyPart } : {}),
          ...(fragment.subjectPart ? { subjectPart: fragment.subjectPart } : {}) } });
  }
  return segments;
}


function splitText(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0) throw new TeamOwnerError('hold');
  const chunks: string[] = [];
  let chunk = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (size > maxBytes) throw new TeamOwnerError('hold');
    if (bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  chunks.push(chunk);
  return chunks;
}

/** Large accepted message text and summary share bounded Unicode-safe parts. */
export function messageSegments(
  messages: JsonValue[],
  itemBudget: number
): Extract<Segment, { kind: 'message' }>[] {
  const segments: Extract<Segment, { kind: 'message' }>[] = [];
  for (const [index, value] of messages.entries()) {
    if (Buffer.byteLength(JSON.stringify(value)) + 2 <= itemBudget) {
      segments.push({ kind: 'message', value, part: { index, part: 0, total: 1 } });
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TeamOwnerError('hold');
    const original = value as Record<string, JsonValue>;
    if (typeof original.text !== 'string' ||
        typeof original.from !== 'string' ||
        typeof original.timestamp !== 'string' ||
        typeof original.read !== 'boolean')
      throw new TeamOwnerError('hold');
    const hasSummary = typeof original.summary === 'string';
    const continuation: Record<string, JsonValue> = {
      from: original.from, timestamp: original.timestamp, read: original.read,
      ...(typeof original.messageId === 'string' ? { messageId: original.messageId } : {}),
      ...(typeof original.source === 'string' ? { source: original.source } : {}),
      ...(typeof original.leadSessionId === 'string' ? { leadSessionId: original.leadSessionId } : {}),
      ...(hasSummary ? { summary: '' } : {}),
      text: '',
    };
    let fragment: Record<string, JsonValue> = {
      ...original, text: '', ...(hasSummary ? { summary: '' } : {}),
    };
    const chunks: JsonValue[] = [];
    const budget = itemBudget - 64;
    let bytes = Buffer.byteLength(JSON.stringify(fragment));
    if (bytes >= budget) throw new TeamOwnerError('hold');
    for (const field of hasSummary ? ['text', 'summary'] as const : ['text'] as const) {
      const text = original[field];
      if (typeof text !== 'string') throw new TeamOwnerError('hold');
      for (const character of text) {
        const size = Buffer.byteLength(JSON.stringify(character)) - 2;
        if (bytes + size > budget) {
          chunks.push(fragment);
          fragment = { ...continuation };
          bytes = Buffer.byteLength(JSON.stringify(fragment));
        }
        if (bytes + size > budget) throw new TeamOwnerError('hold');
        fragment[field] = (fragment[field] as string) + character;
        bytes += size;
      }
    }
    chunks.push(fragment);
    for (const [part, value] of chunks.entries())
      segments.push({ kind: 'message', value,
        part: { index, part, total: chunks.length } });
  }
  return segments;
}

/** Reversible, revision-bound product pages. The Owner holds the authority fence. */
export function pageOwnerSnapshot(options: {
  principalId: string;
  key: string;
  snapshot: JsonValue;
  cursor?: string;
  /** Trusted composition may use a smaller envelope (for example MCP). */
  maxBytes?: number;
}): JsonValue {
  if (!options.snapshot || typeof options.snapshot !== 'object' || Array.isArray(options.snapshot))
    throw new TeamOwnerError('hold');
  const source = options.snapshot as Record<string, JsonValue>;
  if (
    !Array.isArray(source.tasks) ||
    !Array.isArray(source.messages) ||
    typeof source.teamName !== 'string' ||
    typeof source.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.revision)
  ) throw new TeamOwnerError('hold');

  const kanban = source.kanbanState;
  if (!kanban || typeof kanban !== 'object' || Array.isArray(kanban))
    throw new TeamOwnerError('hold');
  const board = kanban as Record<string, JsonValue>;
  if (
    !board.tasks || typeof board.tasks !== 'object' || Array.isArray(board.tasks) ||
    !Array.isArray(board.reviewers)
  ) throw new TeamOwnerError('hold');
  const originalOrder = board.columnOrder;
  if (
    originalOrder !== undefined &&
    (!originalOrder || typeof originalOrder !== 'object' || Array.isArray(originalOrder))
  ) throw new TeamOwnerError('hold');
  const columns = originalOrder === undefined
    ? []
    : Object.entries(originalOrder as Record<string, JsonValue>).map(([name, values]) => {
        if (!Array.isArray(values)) throw new TeamOwnerError('hold');
        return [name, values] as const;
      });

  if (source.processes !== undefined && !Array.isArray(source.processes))
    throw new TeamOwnerError('hold');
  const processes = source.processes as JsonValue[] | undefined;

  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_PAGE_BYTES)
    throw new TeamOwnerError('invalid');
  const budget = maxBytes - 256;
  const basePage = {
    ...source,
    tasks: [] as JsonValue[],
    messages: [] as JsonValue[],
    ...(processes === undefined ? {} : { processes: [] as JsonValue[] }),
    kanbanState: {
      ...board,
      tasks: {} as Record<string, JsonValue>,
      reviewers: [] as JsonValue[],
      ...(originalOrder === undefined ? {} : {
        columnOrder: Object.fromEntries(columns.map(([name]) => [name, [] as JsonValue[]])) as Record<string, JsonValue[]>,
      }),
    },
    nextCursor: null as string | null,
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(basePage));
  if (baseBytes > budget - 512) throw new TeamOwnerError('hold');
  const itemBudget = budget - baseBytes - 512;
  const taskItems = taskSegments(source.tasks, itemBudget);
  const messageItems = messageSegments(source.messages, itemBudget);
  const fragmentedTasks = taskItems.length !== source.tasks.length;
  const fragmentedMessages = messageItems.length !== source.messages.length;

  // Task, message and Kanban records share one original ordered revision.
  // Task parts are ordinary projected task rows with explicit ordering metadata.
  const segments: Segment[] = [
    ...taskItems,
    ...messageItems,
    ...(processes ?? []).map((value) => ({ kind: 'process' as const, value })),
    ...Object.entries(board.tasks as Record<string, JsonValue>).map(([key, value]) => ({
      kind: 'kanban-task' as const, key, value,
    })),
    ...board.reviewers.map((value) => ({ kind: 'reviewer' as const, value })),
    ...columns.flatMap(([key, values]) =>
      values.map((value) => ({ kind: 'column-order' as const, key, value }))
    ),
  ];
  const total = segments.length;
  const signature = (offset: number) =>
    digest({
      key: options.key,
      principalId: options.principalId,
      teamName: source.teamName,
      revision: source.revision,
      maxBytes,
      protocol: 'product-parts-v2',
      offset,
    });
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = CURSOR.exec(options.cursor);
    if (!match) throw new TeamOwnerError('invalid');
    offset = Number(match[1]);
    if (offset >= total || match[2] !== signature(offset)) throw new TeamOwnerError('hold');
  }

  const page = {
    ...basePage,
    ...(fragmentedTasks ? {
      taskTotal: source.tasks.length,
      taskParts: [] as TaskPart[],
    } : {}),
    ...(fragmentedMessages ? {
      messageTotal: source.messages.length,
      messageParts: [] as TaskPart[],
    } : {}),
    ...(processes === undefined ? {} : { processTotal: processes.length }),
  };
  let bytes = Buffer.byteLength(JSON.stringify(page));
  if (bytes > budget) throw new TeamOwnerError('hold');
  let end = offset;
  for (; end < total; end++) {
    const segment = segments[end];
    if (!segment) throw new TeamOwnerError('hold');
    // Account for all array punctuation, map keys and optional task indexes.
    const nextBytes = Buffer.byteLength(JSON.stringify(segment.value)) +
      ('key' in segment ? Buffer.byteLength(JSON.stringify(segment.key)) + 2
        : segment.kind === 'task' && fragmentedTasks ||
          segment.kind === 'message' && fragmentedMessages
          ? Buffer.byteLength(JSON.stringify(segment.part)) + 2
          : 1);
    if (bytes + nextBytes > budget) {
      if (end === offset) throw new TeamOwnerError('hold');
      break;
    }
    switch (segment.kind) {
      case 'task':
        page.tasks.push(segment.value);
        page.taskParts?.push(segment.part);
        break;
      case 'message':
        page.messages.push(segment.value);
        page.messageParts?.push(segment.part);
        break;
      case 'process': {
        if (!page.processes) throw new TeamOwnerError('hold');
        page.processes.push(segment.value);
        break;
      }
      case 'kanban-task': page.kanbanState.tasks[segment.key] = segment.value; break;
      case 'reviewer': page.kanbanState.reviewers.push(segment.value); break;
      case 'column-order': {
        const group = page.kanbanState.columnOrder?.[segment.key];
        if (!group) throw new TeamOwnerError('hold');
        group.push(segment.value);
        break;
      }
    }
    bytes += nextBytes;
  }
  page.nextCursor = end < total ? end + '.' + signature(end) : null;
  if (Buffer.byteLength(JSON.stringify(page)) > maxBytes)
    throw new TeamOwnerError('hold');
  return json(page);
}
