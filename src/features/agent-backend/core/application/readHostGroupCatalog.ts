import {
  readGroupCatalogValue,
  readGroupList,
} from '@agent-teams/legacy-agent-host/group-chats/public-values';

import type { TeamGroupChatDTO } from '@agent-teams/legacy-agent-host/group-chats/contracts';

/** Reconstruct a complete original Host group catalog within its caller's read fence. */
export async function readHostGroupCatalog(
  request: (cursor?: string) => Promise<unknown>,
  assertCurrent: () => void
): Promise<TeamGroupChatDTO[]> {
  const rows: TeamGroupChatDTO[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined, revision: string | undefined, total: number | undefined;
  for (let index = 0; index < 128; index++) {
    assertCurrent();
    const result = readGroupCatalogValue(await request(cursor));
    assertCurrent();
    if (Array.isArray(result)) {
      if (cursor !== undefined || revision !== undefined) throw new Error('Mixed Host group pages');
      assertCurrent();
      return result;
    }
    if (revision !== undefined && (revision !== result.revision || total !== result.total))
      throw new Error('Changed Host group catalog');
    revision ??= result.revision;
    total ??= result.total;
    if (rows.length + result.groups.length > result.total)
      throw new Error('Invalid Host group page length');
    for (const group of result.groups) {
      if (seen.has(group.id)) throw new Error('Duplicate Host group');
      seen.add(group.id);
      rows.push(group);
    }
    if (result.nextCursor === null) {
      if (rows.length !== total) throw new Error('Incomplete Host group catalog');
      assertCurrent();
      return readGroupList(rows);
    }
    if (cursors.has(result.nextCursor)) throw new Error('Repeated Host group cursor');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Host group catalog exceeded page limit');
}
