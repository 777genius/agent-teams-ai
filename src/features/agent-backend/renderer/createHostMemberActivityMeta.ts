import {
  MEMBER_ACTIVITY_META_WINDOW_LIMIT,
  projectMemberActivityFacts,
} from '@shared/utils/memberActivityMeta';

import { HostTeamOperationError } from './createHostTeamMutations';
import { captureHostProjectFamily } from './hostProjectBindings';
import { readHostMessagesPage } from './readHostMessagesPage';

import type { AgentBackendApi } from '../contracts/operations';
import type { TeamProductReadOrder } from './TeamProductReadOrder';
import type { InboxMessage, TeamMemberActivityMeta } from '@shared/types/team';

/** Read the same bounded message window as legacy, through the original Host's signed pages. */
export function createHostMemberActivityMeta(
  backend: AgentBackendApi,
  captureScope: () => () => boolean,
  readOrder: TeamProductReadOrder
) {
  return async (teamName: string): Promise<TeamMemberActivityMeta> => {
    const check = captureScope();
    const current = () => {
      if (!check()) throw new HostTeamOperationError('context-changed', 'not-dispatched');
    };
    current();
    const connections = await backend.getConnections();
    current();
    const family = captureHostProjectFamily(connections, teamName);
    readOrder.capture(check);
    const fence = readOrder.readFence(family.selected.handle.handleId);
    const assertCurrent = () => {
      current();
      fence();
    };
    const newestFirst: InboxMessage[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let revision: string | undefined;
    // A large message may need its own page. The existing reader finishes its
    // original fragments; each iteration here must contribute a logical record.
    for (let index = 0; index < MEMBER_ACTIVITY_META_WINDOW_LIMIT; index++) {
      assertCurrent();
      const remaining = MEMBER_ACTIVITY_META_WINDOW_LIMIT - newestFirst.length;
      const page = await readHostMessagesPage(
        backend,
        family.selected,
        family.bindings,
        teamName,
        { limit: Math.min(100, remaining), ...(cursor === undefined ? {} : { cursor }) },
        check,
        readOrder
      );
      assertCurrent();
      if (
        !page.feedRevision ||
        (revision !== undefined && revision !== page.feedRevision) ||
        page.messages.length > remaining
      )
        throw new HostTeamOperationError('invalid-result', 'unknown');
      revision ??= page.feedRevision;
      // Host pages are oldest-first inside each newest-to-oldest continuation.
      newestFirst.push(...page.messages.toReversed());
      if (newestFirst.length === MEMBER_ACTIVITY_META_WINDOW_LIMIT || !page.hasMore) break;
      if (!page.messages.length || !page.nextCursor || cursors.has(page.nextCursor))
        throw new HostTeamOperationError('invalid-result', 'unknown');
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    family.assertSame(await backend.getConnections());
    assertCurrent();
    return {
      teamName,
      computedAt: new Date().toISOString(),
      feedRevision: revision!,
      members: projectMemberActivityFacts(newestFirst),
    };
  };
}
