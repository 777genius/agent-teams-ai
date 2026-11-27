import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import type { QueuedUserMessageSummary } from './queuedUserMessageRows.js';

const MAX_PAGE_BYTES = 240 * 1024;
const MAX_ROWS = 512;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;
interface QueueInventory {
  kind: 'queued_user_messages';
  member: string;
  messages: { messageId: string }[];
  revision?: string;
  nextCursor?: string | null;
}

/** Confirmation needs exact identities; retained text stays with the original queue authority. */
export function pageQueuedUserMessages(options: {
  key: string;
  authorityFingerprint: string;
  snapshot: { member: string; messages: readonly QueuedUserMessageSummary[] };
  cursor?: string;
}): QueueInventory {
  const { snapshot } = options;
  if (snapshot.messages.length > 4096) throw new TeamOwnerError('hold');
  const ids = new Set<string>();
  const messages = snapshot.messages.map(({ messageId }) => {
    if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 256 ||
        messageId.includes('\0') || ids.has(messageId)) throw new TeamOwnerError('hold');
    ids.add(messageId);
    return { messageId };
  });
  const full: QueueInventory = { kind: 'queued_user_messages', member: snapshot.member, messages };
  if (options.cursor === undefined && messages.length <= MAX_ROWS &&
      Buffer.byteLength(JSON.stringify(full)) <= MAX_PAGE_BYTES) return full;
  const revision = digest(snapshot);
  const signature = (offset: number) => digest({ key: options.key,
    authorityFingerprint: options.authorityFingerprint, protocol: 'queued-user-message-identities-v1', revision, offset });
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = CURSOR.exec(options.cursor);
    if (!match) throw new TeamOwnerError('invalid');
    offset = Number(match[1]);
    if (offset >= messages.length || match[2] !== signature(offset)) throw new TeamOwnerError('hold');
  }
  const page: QueueInventory = {
    kind: 'queued_user_messages', member: snapshot.member, messages: [], revision, nextCursor: null,
  };
  // Reserve the entire signed continuation before admitting another whole identity.
  let bytes = Buffer.byteLength(JSON.stringify(page)) + 256;
  let end = offset;
  for (; end < messages.length && page.messages.length < MAX_ROWS; end++) {
    const message = messages[end]!, size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes + size > MAX_PAGE_BYTES) break;
    page.messages.push(message); bytes += size;
  }
  if (end === offset) throw new TeamOwnerError('hold');
  page.nextCursor = end < messages.length ? end + '.' + signature(end) : null;
  if (Buffer.byteLength(JSON.stringify(page)) > MAX_PAGE_BYTES) throw new TeamOwnerError('hold');
  return page;
}
