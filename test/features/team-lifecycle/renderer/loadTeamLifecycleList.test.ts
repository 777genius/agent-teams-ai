import {
  type CanonicalListTeamLifecycleResult,
  type CanonicalTeamLifecycleListItem,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadTransportApi,
} from '@features/team-lifecycle/contracts';
import {
  loadTeamLifecycleList,
  TEAM_LIFECYCLE_LIST_MAX_ITEMS,
  TEAM_LIFECYCLE_LIST_MAX_PAGES,
} from '@features/team-lifecycle/renderer';
import {
  type Cursor,
  parseCursor,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const REVISION_A = parseRevision('revision_loader-a');
const REVISION_B = parseRevision('revision_loader-b');
const CURSOR_A = parseCursor('cursor_loader-a');
const CURSOR_B = parseCursor('cursor_loader-b');
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);

function item(index: number): CanonicalTeamLifecycleListItem {
  return {
    workspaceId: WORKSPACE_ID,
    teamId: parseTeamId(`team_${index.toString(16).padStart(32, '0')}`),
    displayName: `Team ${index}`,
    lifecycle: 'ready',
    revision: parseRevision(`revision_item-${index}`),
  };
}

function success(
  items: readonly CanonicalTeamLifecycleListItem[],
  nextCursor: Cursor | null,
  snapshotRevision: Revision = REVISION_A
): CanonicalListTeamLifecycleResult {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'success',
    snapshotRevision,
    items,
    nextCursor,
  };
}

function transport(
  implementation: TeamLifecycleReadTransportApi['listTeamLifecycle']
): TeamLifecycleReadTransportApi {
  return { listTeamLifecycle: vi.fn(implementation) };
}

describe('loadTeamLifecycleList', () => {
  it('loads every page and pins the first snapshot revision on later requests', async () => {
    const read = transport(
      vi
        .fn()
        .mockResolvedValueOnce(success([item(1)], CURSOR_A))
        .mockResolvedValueOnce(success([item(2)], null))
    );

    const result = await loadTeamLifecycleList(read, new AbortController().signal);

    expect(read.listTeamLifecycle).toHaveBeenNthCalledWith(1, {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      cursor: null,
      expectedRevision: null,
    });
    expect(read.listTeamLifecycle).toHaveBeenNthCalledWith(2, {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      cursor: CURSOR_A,
      expectedRevision: REVISION_A,
    });
    expect(result).toEqual(success([item(1), item(2)], null));
  });

  it('preserves empty success and typed source failure', async () => {
    const empty = success([], null);
    const sourceFailure: CanonicalListTeamLifecycleResult = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: { code: 'conflict', reason: 'snapshot_changed' },
      retryable: false,
    };

    await expect(
      loadTeamLifecycleList(
        transport(vi.fn().mockResolvedValue(empty)),
        new AbortController().signal
      )
    ).resolves.toEqual(empty);
    await expect(
      loadTeamLifecycleList(
        transport(vi.fn().mockResolvedValue(sourceFailure)),
        new AbortController().signal
      )
    ).resolves.toBe(sourceFailure);
  });

  it.each([
    [
      'changed revision',
      [success([item(1)], CURSOR_A), success([item(2)], null, REVISION_B)],
      'snapshot_revision_changed',
    ],
    [
      'duplicate TeamId',
      [success([item(1)], CURSOR_A), success([item(1)], null)],
      'duplicate_team_id',
    ],
    ['cursor cycle', [success([item(1)], CURSOR_A), success([item(2)], CURSOR_A)], 'cursor_cycle'],
    [
      'duplicate cursor',
      [success([item(1)], CURSOR_A), success([item(2)], CURSOR_B), success([item(3)], CURSOR_A)],
      'duplicate_cursor',
    ],
  ] as const)('rejects %s', async (_name, pages, reason) => {
    let page = 0;
    const read = transport(vi.fn(async () => pages[page++]!));
    const result = await loadTeamLifecycleList(read, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'failure', error: { code: 'internal', reason } });
  });

  it('rejects excess items and pages at fixed production bounds', async () => {
    const tooManyItems = Array.from({ length: TEAM_LIFECYCLE_LIST_MAX_ITEMS + 1 }, (_, index) =>
      item(index)
    );
    const itemResult = await loadTeamLifecycleList(
      transport(vi.fn().mockResolvedValue(success(tooManyItems, null))),
      new AbortController().signal
    );
    expect(itemResult).toMatchObject({
      kind: 'failure',
      error: { reason: 'item_limit_exceeded' },
    });

    let page = 0;
    const pageResult = await loadTeamLifecycleList(
      transport(
        vi.fn(async () => {
          page += 1;
          return success([], parseCursor(`cursor_page-${page}`));
        })
      ),
      new AbortController().signal
    );
    expect(page).toBe(TEAM_LIFECYCLE_LIST_MAX_PAGES);
    expect(pageResult).toMatchObject({
      kind: 'failure',
      error: { reason: 'page_limit_exceeded' },
    });
  });

  it('returns cancellation before work and fences an in-flight stale completion', async () => {
    const before = new AbortController();
    before.abort();
    const notCalled = transport(vi.fn());
    await expect(loadTeamLifecycleList(notCalled, before.signal)).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'cancelled' },
    });
    expect(notCalled.listTeamLifecycle).not.toHaveBeenCalled();

    const inFlight = new AbortController();
    let resolve!: (value: CanonicalListTeamLifecycleResult) => void;
    const pending = new Promise<CanonicalListTeamLifecycleResult>((done) => {
      resolve = done;
    });
    const load = loadTeamLifecycleList(
      transport(vi.fn().mockReturnValue(pending)),
      inFlight.signal
    );
    inFlight.abort();
    resolve(success([item(1)], null));
    await expect(load).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'cancelled' },
    });
  });
});
