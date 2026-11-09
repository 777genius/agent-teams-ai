import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';

const MAX_PAGE_BYTES = 384 * 1024;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

/** Collections which can legitimately grow inside a single retained task. */
const TASK_ARRAY_FIELDS = [
  'comments', 'historyEvents', 'workIntervals', 'reviewIntervals',
  'attachments', 'descriptionTaskRefs', 'promptTaskRefs',
  'blocks', 'blockedBy', 'related',
] as const;

type TaskPart = { index: number; part: number; total: number };
type Segment =
  | { kind: 'task'; value: JsonValue; part: TaskPart }
  | { kind: 'message' | 'reviewer'; value: JsonValue }
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
    const { id, subject, status } = task;
    if (typeof id !== 'string' || typeof subject !== 'string' || typeof status !== 'string')
      throw new TeamOwnerError('hold');
    const base = { ...task };
    const parts: JsonValue[] = [base];
    for (const field of TASK_ARRAY_FIELDS) {
      const items = task[field];
      if (!Array.isArray(items)) continue;
      base[field] = [];
      for (const item of items)
        parts.push({ id, subject, status, [field]: [item] });
    }
    // A single oversized scalar or nested item cannot be made safe by array paging.
    if (parts.length === 1 || parts.some((part) =>
      Buffer.byteLength(JSON.stringify(part)) + 64 > itemBudget
    )) throw new TeamOwnerError('hold');
    for (const [part, fragment] of parts.entries())
      segments.push({ kind: 'task', value: fragment,
        part: { index, part, total: parts.length } });
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

  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_PAGE_BYTES)
    throw new TeamOwnerError('invalid');
  const budget = maxBytes - 256;
  const basePage = {
    ...source,
    tasks: [] as JsonValue[],
    messages: [] as JsonValue[],
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
  const taskItems = taskSegments(source.tasks, budget - baseBytes - 512);
  const fragmentedTasks = taskItems.length !== source.tasks.length;

  // Task, message and Kanban records share one original ordered revision.
  // Task parts are ordinary projected task rows with explicit ordering metadata.
  const segments: Segment[] = [
    ...taskItems,
    ...source.messages.map((value) => ({ kind: 'message' as const, value })),
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
        : segment.kind === 'task' && fragmentedTasks
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
      case 'message': page.messages.push(segment.value); break;
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
