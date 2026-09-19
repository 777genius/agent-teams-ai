import { mkdir, writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNativeMailboxMemberWorkSyncBusySignal } from '@features/member-work-sync/main/adapters/output/NativeMailboxMemberWorkSyncBusySignal';
import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';

describe('native mailbox work-sync busy snapshot', () => {
  let root = '';

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function prepare(snapshot: unknown) {
    root = await mkdtemp(join(tmpdir(), 'work-sync-busy-'));
    const memberRoot = join(
      root,
      'team-a',
      'members',
      encodeTeamMemberStorageKey('bob'),
      '.member-work-sync',
      'runtime-admission'
    );
    await mkdir(memberRoot, { recursive: true });
    await writeFile(
      join(memberRoot, 'capability.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        recoveryProtocolVersion: 2,
        providerId: 'codex',
        processorReady: true,
        runtimeInstanceId: 'runtime-1',
      })}\n`
    );
    await writeFile(join(memberRoot, 'snapshot.json'), `${JSON.stringify(snapshot)}\n`);
    return createNativeMailboxMemberWorkSyncBusySignal({ teamsBasePath: root });
  }

  it('exempts the matching pending continuation ticket after admit', async () => {
    const signal = await prepare({
      runtimeInstanceId: 'runtime-1',
      status: 'dispatching',
      generation: 2,
      continuation: {
        runtimeInstanceId: 'runtime-1',
        reservationNonce: 'nonce-1',
        intentId: 'intent-c1',
        expectedGeneration: 2,
      },
    });
    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-09-14T00:00:00.000Z',
        exactRuntimeTicket: {
          teamName: 'team-a',
          teamIncarnation: 'inc-1',
          memberName: 'bob',
          runtimeInstanceId: 'runtime-1',
          expectedGeneration: 2,
          ticketId: 'nonce-1',
          intentId: 'intent-c1',
          controlRevision: 1,
          admissionPayloadHash: 'hash-a',
        },
      })
    ).resolves.toEqual({ busy: false });
  });

  it('keeps a running query busy even for an exact ticket recheck', async () => {
    const signal = await prepare({
      runtimeInstanceId: 'runtime-1',
      status: 'running',
      generation: 3,
      continuation: null,
    });
    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-09-14T00:00:00.000Z',
        exactRuntimeTicket: {
          teamName: 'team-a',
          teamIncarnation: 'inc-1',
          memberName: 'bob',
          runtimeInstanceId: 'runtime-1',
          expectedGeneration: 2,
          ticketId: 'nonce-1',
          intentId: 'intent-c1',
          controlRevision: 1,
          admissionPayloadHash: 'hash-a',
        },
      })
    ).resolves.toMatchObject({ busy: true, reason: 'query_running' });
  });
});
