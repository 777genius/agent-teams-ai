import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';

const MAX_PAGE_BYTES = 384 * 1024;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

/** Reversible, revision-bound product pages. The Owner holds the authority fence. */
export function pageOwnerSnapshot(options: {
  principalId: string;
  key: string;
  snapshot: JsonValue;
  cursor?: string;
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

  const tasks = source.tasks;
  const messages = source.messages;
  const total = tasks.length + messages.length;
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
    nextCursor: null as string | null,
  };
  // Reserve room for the signed continuation and transport envelope.
  const budget = MAX_PAGE_BYTES - 256;
  let bytes = Buffer.byteLength(JSON.stringify(page));
  if (bytes > budget) throw new TeamOwnerError('hold');
  let end = offset;
  for (; end < total; end++) {
    const value = end < tasks.length ? tasks[end] : messages[end - tasks.length];
    if (value === undefined) throw new TeamOwnerError('hold');
    const nextBytes = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (bytes + nextBytes > budget) {
      // A single overlarge record needs its own detail/history paging.
      if (end === offset) throw new TeamOwnerError('hold');
      break;
    }
    if (end < tasks.length) page.tasks.push(value);
    else page.messages.push(value);
    bytes += nextBytes;
  }
  page.nextCursor = end < total ? end + '.' + signature(end) : null;
  if (Buffer.byteLength(JSON.stringify(page)) > MAX_PAGE_BYTES)
    throw new TeamOwnerError('hold');
  return json(page);
}
