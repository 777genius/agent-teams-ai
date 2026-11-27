import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';

import type { BackendCrossTeamOutbox, BackendCrossTeamOutboxRow } from './contracts.js';

const MAX_PAGE_BYTES = 240 * 1024;
const MAX_ROWS = 1000;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

/** The original intent already fits 96 KiB; retain whole validated public rows.
 * Only the growing collection is paged, within both MCP and Main's row budget.
 */
export function pageCrossTeamOutbox(options: {
  key: string;
  authorityFingerprint: string;
  rows: BackendCrossTeamOutboxRow[];
  cursor?: string;
}): BackendCrossTeamOutbox {
  const full: BackendCrossTeamOutbox = { kind: 'cross-team-outbox', rows: options.rows };
  if (options.cursor === undefined && options.rows.length <= MAX_ROWS &&
      Buffer.byteLength(JSON.stringify(full)) <= MAX_PAGE_BYTES) return full;
  const revision = digest(options.rows);
  const signature = (offset: number) => digest({
    key: options.key, authorityFingerprint: options.authorityFingerprint,
    protocol: 'cross-team-outbox-v1', revision, offset,
  });
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = CURSOR.exec(options.cursor);
    if (!match) throw new TeamOwnerError('invalid');
    offset = Number(match[1]);
    if (offset >= options.rows.length || match[2] !== signature(offset))
      throw new TeamOwnerError('hold');
  }
  const page: BackendCrossTeamOutbox = {
    kind: 'cross-team-outbox', rows: [], revision, nextCursor: null,
  };
  // Reserve the complete signed continuation before admitting another whole row.
  let bytes = Buffer.byteLength(JSON.stringify(page)) + 256;
  let end = offset;
  for (; end < options.rows.length && page.rows.length < MAX_ROWS; end++) {
    const row = options.rows[end]!;
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > MAX_PAGE_BYTES) break;
    page.rows.push(row);
    bytes += size;
  }
  if (end === offset) throw new TeamOwnerError('hold');
  page.nextCursor = end < options.rows.length ? end + '.' + signature(end) : null;
  if (Buffer.byteLength(JSON.stringify(page)) > MAX_PAGE_BYTES) throw new TeamOwnerError('hold');
  return page;
}
