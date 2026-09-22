import {
  applyOpenCodeWorkSyncLaneControl,
  bindOpenCodeWorkSyncLaneReservationRoot,
  readOpenCodeWorkSyncLaneControl,
  resetOpenCodeWorkSyncLaneReservationsForTests,
} from '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore';
import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

describe('OpenCode work-sync control persistence', () => {
  let root: string | undefined;

  afterEach(async () => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
    if (root) await rm(root, { recursive: true, force: true });
  });

  function path(): string {
    return join(
      root!,
      'team-a',
      'members',
      encodeTeamMemberStorageKey('bob'),
      '.member-work-sync',
      'opencode-lane-control.json'
    );
  }

  it('persists immutable request identity and rejects equal-revision conflicts', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-opencode-control-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'runtime-1',
        controlRevision: 4,
        stopped: true,
        requestId: 'stop-1',
      })
    ).toMatchObject({ ok: true, requestId: 'stop-1' });
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'runtime-1',
        controlRevision: 4,
        stopped: true,
        requestId: 'stop-2',
      })
    ).toEqual({ ok: false, code: 'conflict' });
    expect(readOpenCodeWorkSyncLaneControl({ teamName: 'team-a', memberName: 'bob' })).toMatchObject({
      requestId: 'stop-1',
      controlRevision: 4,
      stopped: true,
    });
  });

  it('preserves an existing identity when an equal revision omits requestId', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-opencode-control-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'runtime-1',
        controlRevision: 4,
        stopped: true,
        requestId: 'stop-1',
      })
    ).toMatchObject({ ok: true, requestId: 'stop-1' });
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'runtime-1',
        controlRevision: 4,
        stopped: true,
      })
    ).toMatchObject({ ok: true, requestId: 'stop-1' });
    expect(readOpenCodeWorkSyncLaneControl({ teamName: 'team-a', memberName: 'bob' })).toMatchObject({
      requestId: 'stop-1',
      controlRevision: 4,
      stopped: true,
    });
  });

  it('fails closed without overwriting malformed persisted control', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-opencode-control-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    await mkdir(dirname(path()), { recursive: true });
    await writeFile(path(), '{ malformed\n', 'utf8');
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'runtime-1',
        controlRevision: 5,
        stopped: false,
        requestId: 'resume-5',
      })
    ).toEqual({ ok: false, code: 'conflict' });
    expect(readOpenCodeWorkSyncLaneControl({ teamName: 'team-a', memberName: 'bob' })).toBeNull();

    await writeFile(
      path(),
      `${JSON.stringify({
        runtimeInstanceId: 'runtime-1',
        controlRevision: 4,
        stopped: true,
        handshakeCompleted: true,
        requestId: ' stop-1 ',
      })}\n`,
      'utf8'
    );
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'runtime-1',
        controlRevision: 5,
        stopped: false,
        requestId: 'resume-5',
      })
    ).toEqual({ ok: false, code: 'conflict' });
    expect(readOpenCodeWorkSyncLaneControl({ teamName: 'team-a', memberName: 'bob' })).toBeNull();
  });
});
