import { captureHostNotification } from '../../contracts/hostNotification';
import { parseHostTeamSelectionKey } from '../../contracts/teamSelection';

import type { BackendHandle } from '../../contracts';
import type { BackendConnectionSnapshot } from '../../contracts/connections';
import type { BackendTeamSnapshot } from '../../contracts/teamSnapshot';
import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

type Connection = BackendConnectionSnapshot['bindings'][number];
export interface HostNotificationSource {
  initialize(): Promise<void>;
  isCurrent(): boolean;
  connection(handle: BackendHandle): Connection | undefined;
  readSnapshot(handle: BackendHandle, isCurrent: () => boolean, cursor?: string): Promise<BackendTeamSnapshot>;
}

/** Existing Desktop store owns notifications; Host supplies only original product identity. */
export async function prepareHostNotification(source: HostNotificationSource, raw: unknown) {
  const data = captureHostNotification(raw);
  const handle = Object.freeze({ handleId: parseHostTeamSelectionKey(data.teamName) });
  const assertScope = () => {
    if (!source.isCurrent()) throw new Error('Host notification context changed');
  };
  assertScope();
  await source.initialize();
  assertScope();
  const connection = source.connection(handle);
  if (!connection?.ownerResourceRef || !connection.teamResourceRef)
    throw new Error('Host notification destination unavailable');
  const owner = connection.ownerResourceRef,
    team = connection.teamResourceRef;
  const assertCurrent = () => {
    assertScope();
    const current = source.connection(handle);
    if (current?.ownerResourceRef !== owner || current?.teamResourceRef !== team)
      throw new Error('Host notification owner changed');
  };
  assertCurrent();
  const current = () => {
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const first = await source.readSnapshot(handle, current);
  assertCurrent();
  // Resolve the original target only after all bounded pages have been
  // checked. Main must not treat a partial page as a complete team.
  const tasks = [...first.tasks];
  const seen = new Set<string>();
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor !== undefined && cursor !== null) {
    if (pages++ >= 128 || seen.has(cursor))
      throw new Error('Host notification page continuation unavailable');
    seen.add(cursor);
    const next = await source.readSnapshot(handle, current, cursor);
    assertCurrent();
    if (
      next.teamName !== first.teamName ||
      next.revision !== first.revision ||
      next.feed.streamId !== first.feed.streamId ||
      next.feed.sequence !== first.feed.sequence
    ) throw new Error('Host notification source changed during paged read');
    tasks.push(...next.tasks);
    cursor = next.nextCursor;
  }
  const snapshot = { ...first, tasks };
  const target = data.target!;
  if (target.kind === 'task') {
    const taskParts = snapshot.tasks.filter((row) => row.id === target.taskId);
    if (
      taskParts.length === 0 ||
      (target.commentId !== undefined &&
        !taskParts.some((row) => row.comments?.some((comment) => comment.id === target.commentId)))
    )
      throw new Error('Original Host task destination unavailable');
  } else if (
    target.kind === 'member' &&
    !snapshot.members.some((row) => row.name === target.memberName)
  ) {
    throw new Error('Original Host member destination unavailable');
  }
  const payload: TeamNotificationPayload = {
    teamEventType: data.teamEventType ?? 'task_clarification',
    teamName: data.teamName,
    teamDisplayName: connection.label,
    from: data.from,
    ...(data.to === undefined ? {} : { to: data.to }),
    summary: data.summary ?? `${data.from} → ${data.to ?? 'team'}`,
    body: data.body,
    dedupeKey: `host:${team}:${data.dedupeKey ?? `msg:${data.from}:${data.summary ?? data.body.slice(0, 50)}`}`,
    target,
    // Supplying the original Host roster keeps native avatar resolution out of legacy Team files.
    members: snapshot.members.map((row) => ({
      name: row.name,
      agentType: row.role === 'lead' ? 'team-lead' : 'general-purpose',
    })),
    ...(data.suppressToast === undefined ? {} : { suppressToast: data.suppressToast }),
  };
  return { payload, assertCurrent };
}
