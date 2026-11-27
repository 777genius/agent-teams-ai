import { HostTeamOperationError } from '../contracts/taskSubmission';

import type { BackendCrossTeamOutboxRow } from '../contracts/crossTeam';
import type { BackendHandle } from '../contracts/index';
import type { AgentBackendApi } from '../contracts/operations';

/** Publish the existing complete outbox only after every original page is current. */
export async function readHostCrossTeamOutbox(
  backend: Pick<AgentBackendApi, 'invoke'>,
  handle: BackendHandle,
  current: () => boolean
): Promise<BackendCrossTeamOutboxRow[]> {
  const rows: BackendCrossTeamOutboxRow[] = [];
  const seenCursors = new Set<string>();
  const seenMessages = new Set<string>();
  let cursor: string | undefined;
  let revision: string | undefined;
  const invalid = (): never => {
    throw new HostTeamOperationError('invalid-result', 'unknown');
  };
  for (let index = 0; ; index++) {
    if (!current()) throw new HostTeamOperationError('context-changed', 'unknown');
    const result = await backend.invoke({
      handle,
      commandId: crypto.randomUUID(),
      operation: 'crossTeam.outbox.read',
      payload: cursor === undefined ? {} : { cursor },
    });
    if (!current()) throw new HostTeamOperationError('context-changed', 'unknown');
    if (!result.ok) throw new HostTeamOperationError(result.code, result.outcome);
    const page = result.value;
    if (
      !page ||
      !('kind' in page) ||
      page.kind !== 'cross-team-outbox' ||
      !Array.isArray(page.rows) ||
      page.rows.length > 1000
    )
      return invalid();
    if (page.revision === undefined && page.nextCursor === undefined) {
      if (index !== 0) return invalid();
      return page.rows;
    }
    if (
      typeof page.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(page.revision) ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== 'string' ||
          !/^[1-9][0-9]{0,8}\.[a-f0-9]{64}$/.test(page.nextCursor))) ||
      (revision !== undefined && page.revision !== revision) ||
      page.rows.length === 0
    )
      return invalid();
    revision = page.revision;
    for (const row of page.rows) {
      if (seenMessages.has(row.messageId)) return invalid();
      seenMessages.add(row.messageId);
      rows.push(row);
    }
    if (page.nextCursor === null) return rows;
    if (seenCursors.has(page.nextCursor) || Number(page.nextCursor.split('.')[0]) !== rows.length)
      return invalid();
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
