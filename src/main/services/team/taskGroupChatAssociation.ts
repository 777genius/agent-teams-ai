import type { TeamGroupChatDTO } from '@features/team-group-chats/contracts';

export type TaskGroupChatCatalog = (teamName: string) => Promise<TeamGroupChatDTO[]>;

/** Admission for a new link only. Existing links and explicit unlink need no catalog. */
export async function assertTaskGroupChatAssociation(
  teamName: string,
  groupChatId: unknown,
  currentGroupChatId: string | undefined,
  catalog: TaskGroupChatCatalog | null
): Promise<void> {
  if (groupChatId === undefined) return;
  if (
    typeof groupChatId !== 'string' ||
    !/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
      groupChatId
    )
  ) {
    throw new TypeError('groupChatId must be a UUID');
  }
  if (groupChatId === currentGroupChatId) return;
  if (!catalog) throw new Error('Group chat catalog is unavailable');
  const group = (await catalog(teamName)).find((candidate) => candidate.id === groupChatId);
  if (!group) throw new Error('Group chat does not belong to this team');
  if (group.archivedAt) throw new Error('Cannot associate a task with an archived group chat');
}
