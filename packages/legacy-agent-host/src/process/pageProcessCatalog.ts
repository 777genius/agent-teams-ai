import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';

import type { TeamProcessView } from './registeredProcessContracts.js';

const MAX_PAGE_BYTES = 240 * 1024;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

/** Private MCP continuation over complete, original Owner-projected process rows. */
export function pageProcessCatalog(options: {
  rows: TeamProcessView[];
  key: string;
  cursor?: string;
}): TeamProcessView[] | {
  kind: 'process-catalog-page';
  processes: TeamProcessView[];
  total: number;
  revision: string;
  nextCursor: string | null;
} {
  const { rows, key } = options;
  if (!Array.isArray(rows) || rows.length > 1024) throw new TeamOwnerError('hold');
  if (options.cursor === undefined && Buffer.byteLength(JSON.stringify(rows)) <= MAX_PAGE_BYTES)
    return rows;
  const revision = digest(rows);
  const signature = (offset: number) => digest({
    protocol: 'process-catalog-v1', key, revision, offset,
  });
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = CURSOR.exec(options.cursor);
    if (!match) throw new TeamOwnerError('invalid');
    offset = Number(match[1]);
    if (offset >= rows.length || match[2] !== signature(offset))
      throw new TeamOwnerError('hold');
  }
  const page = {
    kind: 'process-catalog-page' as const,
    processes: [] as TeamProcessView[],
    total: rows.length,
    revision,
    nextCursor: null as string | null,
  };
  // Cursor and JSON envelope fit in the unchanged 256 KiB MCP formatter.
  let bytes = Buffer.byteLength(JSON.stringify(page)) + 256;
  let end = offset;
  for (; end < rows.length; end++) {
    const row = rows[end]!;
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > MAX_PAGE_BYTES) break;
    page.processes.push(row);
    bytes += size;
  }
  if (end === offset) throw new TeamOwnerError('hold');
  page.nextCursor = end < rows.length ? end + '.' + signature(end) : null;
  if (Buffer.byteLength(JSON.stringify(page)) > MAX_PAGE_BYTES) throw new TeamOwnerError('hold');
  return page;
}
