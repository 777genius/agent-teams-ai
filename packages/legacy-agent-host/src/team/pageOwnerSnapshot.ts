import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';

const MAX_PAGE_BYTES = 384 * 1024;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

type Segment =
  | { kind: 'task' | 'message' | 'reviewer'; value: JsonValue }
  | { kind: 'kanban-task' | 'column-order'; key: string; value: JsonValue };

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
  // Task, message and Kanban records share one original ordered revision.
  // Even a large Kanban board cannot disable ordinary team and MCP reads.
  const segments: Segment[] = [
    ...source.tasks.map((value) => ({ kind: 'task' as const, value })),
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
    ...source,
    tasks: [] as JsonValue[],
    messages: [] as JsonValue[],
    kanbanState: {
      ...board,
      tasks: {} as Record<string, JsonValue>,
      reviewers: [] as JsonValue[],
      ...(originalOrder === undefined ? {} : {
        columnOrder: Object.fromEntries(columns.map(([name]) => [name, [] as JsonValue[]]))
          as Record<string, JsonValue[]>,
      }),
    },
    nextCursor: null as string | null,
  };
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_PAGE_BYTES)
    throw new TeamOwnerError('invalid');
  // Reserve room for the signed continuation and transport envelope.
  const budget = maxBytes - 256;
  let bytes = Buffer.byteLength(JSON.stringify(page));
  if (bytes > budget) throw new TeamOwnerError('hold');
  let end = offset;
  for (; end < total; end++) {
    const segment = segments[end];
    if (!segment) throw new TeamOwnerError('hold');
    // Account for map keys and punctuation as well as the retained record bytes.
    const nextBytes = Buffer.byteLength(JSON.stringify(segment.value)) +
      ('key' in segment ? Buffer.byteLength(JSON.stringify(segment.key)) + 2 : 1);
    if (bytes + nextBytes > budget) {
      // A single overlarge record needs its own detail/history paging.
      if (end === offset) throw new TeamOwnerError('hold');
      break;
    }
    switch (segment.kind) {
      case 'task': page.tasks.push(segment.value); break;
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
