import { GroupChatError, isGroupPhysicalId } from './model.js';
import type { GroupChat } from './model.js';

function isNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((name) => typeof name === 'string' && name.trim() === name && !!name) &&
    new Set(value).size === value.length
  );
}

export function validCreationMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  const payload = metadata.payload as Record<string, unknown> | undefined;
  return (
    isGroupPhysicalId(metadata.sourceMessageId) &&
    isNames(metadata.recipientNames) &&
    metadata.recipientNames.length > 0 &&
    metadata.recipientNames.length <= 200 &&
    !metadata.recipientNames.some((name) => name.toLowerCase() === 'user') &&
    !!payload &&
    typeof payload.name === 'string' &&
    !!payload.name.trim() &&
    payload.name.length <= 100 &&
    payload.name === payload.name.trim() &&
    typeof payload.autoIncludeNewMembers === 'boolean' &&
    isNames(payload.selectedMemberNames) &&
    payload.selectedMemberNames.length >= 2 &&
    payload.selectedMemberNames.length <= 200 &&
    !payload.selectedMemberNames.includes('user')
  );
}

/** Exact bounded registry schema shared by both captured and legacy writers. */
export function parseGroupRegistry(raw: unknown): GroupChat[] {
  let groups: GroupChat[] = [];
  if (raw !== undefined) {
    const document = raw as { version?: unknown; groups?: unknown };
    if (document?.version !== 1 || !Array.isArray(document.groups))
      throw new GroupChatError('storage-unavailable', 'Unsupported group registry');
    const ids = new Set<string>();
    for (const row of document.groups as GroupChat[]) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !row.id ||
        ids.has(row.id) ||
        typeof row.name !== 'string' ||
        !row.name.trim() ||
        typeof row.createdAt !== 'string' ||
        (row.archivedAt !== null && typeof row.archivedAt !== 'string') ||
        (row.agentCreation !== undefined && !validCreationMetadata(row.agentCreation)) ||
        !row.membership ||
        (row.membership.kind === 'fixed'
          ? !isNames(row.membership.memberNames)
          : row.membership.kind !== 'auto' || !isNames(row.membership.excludedMemberNames))
      ) {
        throw new GroupChatError('storage-unavailable', 'Malformed group registry');
      }
      ids.add(row.id);
    }
    groups = document.groups as GroupChat[];
  }
  return groups;
}
