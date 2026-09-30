import {
  type CanonicalListTeamLifecycleResult,
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '@features/team-lifecycle/contracts';
import { createHostedTeamDirectoryReadSession } from '@features/team-lifecycle/renderer';
import { parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const WORKSPACE_A = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const WORKSPACE_B = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const REVISION = parseRevision(`revision_${'c'.repeat(64)}`);

function success(
  workspaceId: typeof WORKSPACE_A,
  name: string
): Extract<CanonicalListTeamLifecycleResult, { readonly kind: 'success' }> {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'success',
    snapshotRevision: REVISION,
    items: [{
      workspaceId,
      teamId: parseTeamId(`team_${workspaceId === WORKSPACE_A ? 'd'.repeat(32) : 'e'.repeat(32)}`),
      displayName: name,
      lifecycle: 'ready',
      revision: REVISION,
    }],
    nextCursor: null,
  };
}

const unavailable: CanonicalListTeamLifecycleResult = {
  schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  kind: 'failure',
  error: { code: 'unavailable', reason: 'storage_unavailable' },
  retryable: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function transport(listTeamLifecycle: (...args: never[]) => Promise<CanonicalListTeamLifecycleResult>) {
  return {
    listTeamLifecycle,
    getControlState: vi.fn(async () => ({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      kind: 'unavailable' as const,
      retryAfterMs: null,
    })),
  };
}

describe('Hosted team directory read session', () => {
  it('retains a complete snapshot as stale after a failed refresh', async () => {
    const source = transport(vi.fn()
      .mockResolvedValueOnce(success(WORKSPACE_A, 'Previously visible'))
      .mockResolvedValueOnce(unavailable));
    const session = createHostedTeamDirectoryReadSession(WORKSPACE_A, source);

    await session.reload();
    expect(session.getState()).toMatchObject({ freshness: 'fresh', failure: null });
    expect(session.getState().snapshot?.items.map((item) => item.displayName))
      .toEqual(['Previously visible']);
    await session.reload();
    expect(session.getState()).toMatchObject({ freshness: 'stale', failure: { kind: 'failure' } });
    expect(session.getState().snapshot?.items.map((item) => item.displayName))
      .toEqual(['Previously visible']);
    expect(session.getState().runtime.byTeamId.size).toBe(0);
    session.cancel();
  });

  it('does not publish a pre-receipt result and coalesces invalidation to one follow-up', async () => {
    const first = deferred<CanonicalListTeamLifecycleResult>();
    const source = transport(vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(success(WORKSPACE_A, 'After receipt')));
    const session = createHostedTeamDirectoryReadSession(WORKSPACE_A, source);
    const initial = session.reload();
    session.advanceWatermark();
    void session.reload();
    void session.reload();

    first.resolve(success(WORKSPACE_A, 'Before receipt'));
    await initial;
    await vi.waitFor(() => expect(source.listTeamLifecycle).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(session.getState().snapshot?.items[0]?.displayName)
      .toBe('After receipt'));
    expect(session.getState().snapshot?.readStartedAtWatermark).toBe(1);
    expect(session.getState().freshness).toBe('fresh');
    session.cancel();
  });

  it('filters to the selected workspace and fences late responses after a scope switch', async () => {
    const lateA = deferred<CanonicalListTeamLifecycleResult>();
    const sourceA = transport(vi.fn().mockReturnValue(lateA.promise));
    const sessionA = createHostedTeamDirectoryReadSession(WORKSPACE_A, sourceA);
    const readA = sessionA.reload();
    sessionA.cancel();

    const sourceB = transport(vi.fn().mockResolvedValue({
      ...success(WORKSPACE_B, 'Selected B'),
      items: [
        ...success(WORKSPACE_A, 'Other A').items,
        ...success(WORKSPACE_B, 'Selected B').items,
      ],
    }));
    const sessionB = createHostedTeamDirectoryReadSession(WORKSPACE_B, sourceB);
    await sessionB.reload();
    lateA.resolve(success(WORKSPACE_A, 'Late A'));
    await readA;

    expect(sessionB.getState().scopeKey).toBe(WORKSPACE_B);
    expect(sessionB.getState().snapshot?.items.map((item) => item.displayName))
      .toEqual(['Selected B']);
    expect(sessionA.getState().snapshot).toBeNull();
    sessionB.cancel();
  });

  it('keeps an initial list failure distinct from successful empty', async () => {
    const session = createHostedTeamDirectoryReadSession(
      WORKSPACE_A,
      transport(vi.fn().mockResolvedValue(unavailable))
    );
    await session.reload();
    expect(session.getState()).toMatchObject({ freshness: 'failed', snapshot: null });
    session.cancel();
  });
});
