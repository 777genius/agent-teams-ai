import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';
import type { TeamGrant } from './contracts.js';
import type { TeamTaskInventoryFilters } from './ports.js';

const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;
const INLINE_BYTES = 240 * 1024;
const CHUNK_BYTES = 64 * 1024;

export type OwnerBriefingScope = { authorityFingerprint: string } & (
  | { kind: 'task'; memberName: string }
  | { kind: 'lead' }
  | { kind: 'member'; memberName: string; includeActiveProcesses: boolean }
);

/** Native MCP task_get keeps small original results and streams oversized
 * canonical JSON as signed, revision-bound, Unicode-safe text chunks.
 * No caller may select another Team, owner, root, or grant.
 */
export function pageOwnerTaskDetail(options: {
  principalId: string;
  grant: TeamGrant;
  key: string;
  teamName: string;
  taskId: string;
  task: JsonValue;
  cursor?: string;
}): JsonValue {
  const source = options.task;
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      (source as Record<string, JsonValue>).id !== options.taskId)
    throw new TeamOwnerError('hold');
  return pageOwnerReadDetail({ ...options, value: source });
}

/** Shared lossless read pages; the caller supplies canonical identities only
 * after its current Owner read fence and policy have resolved the request.
 */
export function pageOwnerReadDetail(options: {
  principalId: string;
  grant: TeamGrant;
  key: string;
  teamName: string;
  value: JsonValue;
  cursor?: string;
} & (
  | { taskId: string; commentId?: string }
  | { inventoryFilters: TeamTaskInventoryFilters }
  | { briefingScope: OwnerBriefingScope }
)): JsonValue {
  const source = options.value;
  const serialized = JSON.stringify(source);
  if (Buffer.byteLength(serialized) <= INLINE_BYTES) {
    if (options.cursor !== undefined) throw new TeamOwnerError('hold');
    return json(source);
  }
  const revision = digest(source);
  // JSON text is split at codepoint boundaries. The escaped JSON-string envelope
  // is budgeted so the MCP result stays well below its 256 KiB transport cap.
  const chunks: string[] = [];
  let chunk = '', bytes = 0;
  for (const character of serialized) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  const briefing = 'briefingScope' in options;
  const inventory = 'inventoryFilters' in options;
  const signature = (offset: number) => digest(briefing ? {
    key: options.key, principalId: options.principalId, grant: options.grant,
    teamName: options.teamName, briefingScope: options.briefingScope, revision,
    protocol: 'briefing-json-chunk-v1', offset,
  } : inventory ? {
    key: options.key, principalId: options.principalId, grant: options.grant,
    teamName: options.teamName, inventoryFilters: options.inventoryFilters, revision,
    protocol: 'task-inventory-json-chunk-v1', offset,
  } : {
    key: options.key, principalId: options.principalId, grant: options.grant,
    teamName: options.teamName, taskId: options.taskId, revision,
    ...(options.commentId === undefined ? {} : { commentId: options.commentId }),
    protocol: options.commentId === undefined ? 'task-json-chunk-v1' : 'task-comment-json-chunk-v1', offset,
  });
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = CURSOR.exec(options.cursor);
    if (!match) throw new TeamOwnerError('invalid');
    offset = Number(match[1]);
    if (offset >= chunks.length || match[2] !== signature(offset))
      throw new TeamOwnerError('hold');
  }
  return json({
    ...(briefing ? { kind: 'briefing-chunk' } : inventory ? { kind: 'task-inventory-chunk' } : {
      kind: options.commentId === undefined ? 'task-detail-chunk' : 'task-comment-chunk',
      taskId: options.taskId,
      ...(options.commentId === undefined ? {} : { commentId: options.commentId }),
    }),
    revision,
    part: offset,
    total: chunks.length,
    chunk: chunks[offset],
    nextCursor: offset + 1 < chunks.length
      ? (offset + 1) + '.' + signature(offset + 1)
      : null,
  });
}
