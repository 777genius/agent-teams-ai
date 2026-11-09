import type { BackendConnectionSnapshot } from '../contracts/connections';
import type { AgentBackendApi } from '../contracts/operations';
import type { BackendTeamSnapshot } from '../contracts/teamSnapshot';
import type { TeamProductReadOrder } from './TeamProductReadOrder';

type Connection = BackendConnectionSnapshot['bindings'][number];
type CurrentScope = () => boolean;

const MAX_PAGES = 128;

/** Publish a complete read only after bounded Owner pages pass the original fences. */
export async function readHostPagedSnapshot(
  backend: Pick<AgentBackendApi, 'invoke'>,
  connection: Connection,
  check: CurrentScope,
  readOrder: TeamProductReadOrder
): Promise<{ data: BackendTeamSnapshot; assertCurrent(): void }> {
  const assertScope = () => {
    if (!check()) throw new Error('Team context changed');
  };
  readOrder.capture(check);
  const handleId = connection.handle.handleId;
  const readFence = readOrder.readFence(handleId);
  let cursor: string | undefined;
  let first: BackendTeamSnapshot | undefined;
  const tasks: BackendTeamSnapshot['tasks'] = [];
  const messages: BackendTeamSnapshot['messages'] = [];
  const seen = new Set<string>();

  for (let index = 0; index < MAX_PAGES; index++) {
    const result = await backend.invoke({
      handle: connection.handle,
      commandId: crypto.randomUUID(),
      operation: 'team.snapshot',
      payload: cursor ? { cursor } : {},
    });
    assertScope();
    if (!result.ok) throw new Error('Host team read ' + result.code);
    if (!result.value || !('revision' in result.value) || !('kanbanState' in result.value))
      throw new Error('Invalid Host team snapshot');
    const page = result.value as BackendTeamSnapshot;
    readFence();
    if (first) {
      if (
        page.revision !== first.revision ||
        page.teamName !== first.teamName ||
        page.feed.streamId !== first.feed.streamId ||
        page.feed.sequence !== first.feed.sequence
      ) throw new Error('Host team changed during paged read');
    } else {
      first = page;
    }
    tasks.push(...page.tasks);
    messages.push(...page.messages);

    if (page.nextCursor === undefined || page.nextCursor === null) {
      const data: BackendTeamSnapshot = { ...first, tasks, messages };
      delete data.nextCursor;
      readOrder.acceptSnapshot(handleId, data);
      return {
        data,
        assertCurrent: () => {
          assertScope();
          readFence();
          readOrder.assertCurrent(handleId, data.feed);
        },
      };
    }
    if (seen.has(page.nextCursor)) throw new Error('Repeated Host team page cursor');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Host team snapshot exceeded page budget');
}
