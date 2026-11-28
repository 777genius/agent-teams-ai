import { readBackendProcessCatalog, readBackendProcesses } from '../../contracts/processes';

import type { BackendProcess } from '../../contracts/processes';

/** Publish one complete original process catalog within the caller's captured read fence. */
export async function readHostProcessCatalog(
  request: (cursor?: string) => Promise<unknown>,
  assertCurrent: () => void
): Promise<BackendProcess[]> {
  const rows: BackendProcess[] = [];
  const seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, revision: string | undefined, total: number | undefined;
  for (let index = 0; index < 128; index++) {
    assertCurrent();
    let value: unknown;
    try { value = await request(cursor); }
    finally { assertCurrent(); }
    const result = readBackendProcessCatalog(value);
    if (Array.isArray(result)) {
      if (cursor !== undefined || revision !== undefined) throw new Error('Mixed Host process pages');
      assertCurrent();
      return result;
    }
    if (revision !== undefined && (revision !== result.revision || total !== result.total))
      throw new Error('Changed Host process catalog');
    revision ??= result.revision;
    total ??= result.total;
    if (rows.length + result.processes.length > result.total)
      throw new Error('Invalid Host process page length');
    for (const process of result.processes) {
      if (seen.has(process.id)) throw new Error('Duplicate Host process');
      seen.add(process.id);
      rows.push(process);
    }
    if (result.nextCursor === null) {
      if (rows.length !== total) throw new Error('Incomplete Host process catalog');
      assertCurrent();
      return readBackendProcesses(rows);
    }
    if (rows.length === total) throw new Error('Invalid Host process continuation');
    if (cursors.has(result.nextCursor)) throw new Error('Repeated Host process cursor');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('Host process catalog exceeded page limit');
}
