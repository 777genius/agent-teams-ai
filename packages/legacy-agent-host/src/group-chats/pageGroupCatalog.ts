import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';

import type { JsonValue } from '../contracts.js';

const PAGE_BYTES = 240 * 1024;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

/** Read-only native MCP projection. Every continuation re-reads the same Owner catalog. */
export function pageGroupCatalog(options: {
  rows: JsonValue[];
  key: string;
  principalId: string;
  binding: string;
  cursor?: string;
}): JsonValue {
  const original = options.rows;
  if (!Array.isArray(original)) throw new TeamOwnerError('hold');
  if (options.cursor === undefined &&
      Buffer.byteLength(JSON.stringify(original)) <= PAGE_BYTES) return original;
  const revision = digest(original);
  const signature = (offset: number) => digest({
    protocol: 'group-catalog-v1', key: options.key, binding: options.binding,
    principalId: options.principalId, revision, offset,
  });
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = CURSOR.exec(options.cursor);
    if (!match) throw new TeamOwnerError('invalid');
    offset = Number(match[1]);
    if (offset >= original.length || match[2] !== signature(offset))
      throw new TeamOwnerError('hold');
  }
  const page = {
    kind: 'group-catalog-page' as const,
    groups: [] as JsonValue[],
    total: original.length,
    revision,
    nextCursor: null as string | null,
  };
  // Reserve room for the signed next cursor while admitting complete original rows.
  let size = Buffer.byteLength(JSON.stringify(page)) + 256;
  let end = offset;
  for (; end < original.length; end++) {
    const item = original[end];
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (size + bytes > PAGE_BYTES) break;
    page.groups.push(item!);
    size += bytes;
  }
  if (end === offset) throw new TeamOwnerError('hold');
  page.nextCursor = end < original.length ? end + '.' + signature(end) : null;
  if (Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES)
    throw new TeamOwnerError('hold');
  return page;
}
