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
  let kanbanState: BackendTeamSnapshot['kanbanState'] | undefined;
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
    // Page-local Kanban fragments are not a complete board. Reconstruct the
    // original ordered map and column arrays before exposing any product view.
    if (!kanbanState) kanbanState = {
      ...page.kanbanState,
      tasks: {},
      reviewers: [],
      ...(page.kanbanState.columnOrder ? { columnOrder: {} } : {}),
    };
    kanbanState.reviewers.push(...page.kanbanState.reviewers);
    for (const [taskId, entry] of Object.entries(page.kanbanState.tasks)) {
      if (Object.hasOwn(kanbanState.tasks, taskId))
        throw new Error('Duplicate Host Kanban task across pages');
      kanbanState.tasks[taskId] = entry;
    }
    for (const [column, ids] of Object.entries(page.kanbanState.columnOrder ?? {})) {
      const key = column as keyof NonNullable<BackendTeamSnapshot['kanbanState']['columnOrder']>;
      const original = kanbanState.columnOrder?.[key] ?? [];
      kanbanState.columnOrder ??= {};
      kanbanState.columnOrder[key] = [...original, ...ids];
    }

    if (page.nextCursor === undefined || page.nextCursor === null) {
      const completeKanban = kanbanState;
      if (!completeKanban) throw new Error('Missing Host Kanban state');
      const fullTasks = tasks.map((task) => {
        const board = completeKanban.tasks[task.id];
        return board ? { ...task, kanbanColumn: board.column, reviewer: board.reviewer } : task;
      });
      const data: BackendTeamSnapshot = {
        ...first,
        tasks: fullTasks,
        messages,
        kanbanState: completeKanban,
      };
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
