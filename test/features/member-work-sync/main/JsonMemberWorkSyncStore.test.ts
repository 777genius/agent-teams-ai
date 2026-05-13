import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import type {
  MemberWorkSyncNudgePayload,
  MemberWorkSyncStatus,
} from '@features/member-work-sync/contracts';
import type { MemberWorkSyncAuditEvent } from '@features/member-work-sync/core/application';

function makeStatus(overrides: Partial<MemberWorkSyncStatus>): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'needs_sync',
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      fingerprint: 'agenda:v1:abc',
      items: [
        {
          taskId: 'task-1',
          displayId: '11111111',
          subject: 'Ship UI',
          kind: 'work',
          assignee: 'bob',
          priority: 'normal',
          reason: 'owned_pending_task',
          evidence: { status: 'pending', owner: 'bob' },
        },
      ],
      diagnostics: [],
    },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: true,
      fingerprintChanged: false,
    },
    evaluatedAt: '2026-04-29T00:00:00.000Z',
    diagnostics: [],
    ...overrides,
  };
}

function makeNudgePayload(
  overrides: Partial<MemberWorkSyncNudgePayload> = {}
): MemberWorkSyncNudgePayload {
  return {
    from: 'system',
    to: 'bob',
    messageKind: 'member_work_sync_nudge',
    source: 'member-work-sync',
    actionMode: 'do',
    workSyncIntent: 'agenda_sync',
    text: 'Work sync check: continue the current task or report a blocker.',
    taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '11111111' }],
    ...overrides,
  };
}

function memberWorkSyncDir(root: string, teamName: string, memberName: string): string {
  return join(
    root,
    teamName,
    'members',
    encodeURIComponent(memberName.trim().toLowerCase()),
    '.member-work-sync'
  );
}

describe('JsonMemberWorkSyncStore', () => {
  let root: string;
  let store: JsonMemberWorkSyncStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'member-work-sync-store-'));
    store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(root));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('quarantines invalid status JSON and returns empty state', async () => {
    const statusPath = join(root, 'team-a', '.member-work-sync', 'status.json');
    await mkdir(join(root, 'team-a', '.member-work-sync'), { recursive: true });
    await writeFile(statusPath, '{bad json', 'utf8');

    await expect(store.read({ teamName: 'team-a', memberName: 'bob' })).resolves.toBeNull();

    const teamDir = join(root, 'team-a', '.member-work-sync');
    const entries = await readdir(teamDir);
    expect(entries.some((entry) => entry.startsWith('status.json.invalid.'))).toBe(true);
  });

  it('writes status into member-scoped storage and keeps team metrics in an index', async () => {
    await store.write(makeStatus({ providerId: 'opencode' }));

    const statusFile = JSON.parse(
      await readFile(join(memberWorkSyncDir(root, 'team-a', 'bob'), 'status.json'), 'utf8')
    );
    expect(statusFile).toMatchObject({
      schemaVersion: 2,
      status: {
        teamName: 'team-a',
        memberName: 'bob',
        providerId: 'opencode',
      },
    });

    const metaFile = JSON.parse(
      await readFile(join(root, 'team-a', 'members', 'bob', 'member.meta.json'), 'utf8')
    );
    expect(metaFile).toMatchObject({
      schemaVersion: 1,
      memberName: 'bob',
      memberKey: 'bob',
    });

    const metricsIndex = JSON.parse(
      await readFile(join(root, 'team-a', '.member-work-sync', 'indexes', 'metrics.json'), 'utf8')
    );
    expect(metricsIndex.members.bob).toMatchObject({
      memberName: 'bob',
      state: 'needs_sync',
      actionableCount: 1,
    });
  });

  it('prefers member-scoped v2 status over legacy v1 status', async () => {
    await store.write(
      makeStatus({ state: 'caught_up', agenda: { ...makeStatus({}).agenda, items: [] } })
    );

    const legacyStatusPath = join(root, 'team-a', '.member-work-sync', 'status.json');
    await mkdir(join(root, 'team-a', '.member-work-sync'), { recursive: true });
    await writeFile(
      legacyStatusPath,
      JSON.stringify({ schemaVersion: 1, members: { bob: makeStatus({ state: 'needs_sync' }) } }),
      'utf8'
    );

    await expect(store.read({ teamName: 'team-a', memberName: 'bob' })).resolves.toMatchObject({
      state: 'caught_up',
    });
  });

  it('deduplicates pending report intents and marks them processed', async () => {
    const request = {
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working' as const,
      agendaFingerprint: 'agenda:v1:abc',
      reportToken: 'wrs:v1.test',
      taskIds: ['task-2', 'task-1', 'task-1'],
      source: 'mcp' as const,
    };

    await store.appendPendingReport(request, 'control_api_unavailable');
    await store.appendPendingReport({ ...request, taskIds: ['task-1', 'task-2'] }, 'duplicate');

    const pending = await store.listPendingReports('team-a');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      teamName: 'team-a',
      memberName: 'bob',
      reason: 'control_api_unavailable',
      status: 'pending',
    });

    await store.markPendingReportProcessed('team-a', pending[0].id, {
      status: 'accepted',
      resultCode: 'accepted',
      processedAt: '2026-04-29T00:00:00.000Z',
    });

    expect(await store.listPendingReports('team-a')).toEqual([]);
    const file = JSON.parse(
      await readFile(join(memberWorkSyncDir(root, 'team-a', 'bob'), 'reports.json'), 'utf8')
    );
    expect(file.intents[pending[0].id]).toMatchObject({
      status: 'accepted',
      resultCode: 'accepted',
    });
    const index = JSON.parse(
      await readFile(
        join(root, 'team-a', '.member-work-sync', 'indexes', 'pending-reports-index.json'),
        'utf8'
      )
    );
    expect(index.items[pending[0].id]).toMatchObject({
      memberName: 'bob',
      status: 'accepted',
    });
  });

  it('repairs a missing pending-report index from member-scoped report files', async () => {
    const request = {
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working' as const,
      agendaFingerprint: 'agenda:v1:abc',
      reportToken: 'wrs:v1.test',
      source: 'mcp' as const,
    };

    await store.appendPendingReport(request, 'control_api_unavailable');
    await rm(join(root, 'team-a', '.member-work-sync', 'indexes', 'pending-reports-index.json'), {
      force: true,
    });

    await expect(store.listPendingReports('team-a')).resolves.toHaveLength(1);
    const repaired = JSON.parse(
      await readFile(
        join(root, 'team-a', '.member-work-sync', 'indexes', 'pending-reports-index.json'),
        'utf8'
      )
    );
    expect(Object.values(repaired.items)).toEqual([
      expect.objectContaining({ memberName: 'bob', status: 'pending' }),
    ]);
  });

  it('repairs a stale pending-report index route from member-scoped report files', async () => {
    const bobRequest = {
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working' as const,
      agendaFingerprint: 'agenda:v1:bob',
      reportToken: 'wrs:v1.bob',
      source: 'mcp' as const,
    };
    const tomRequest = {
      ...bobRequest,
      memberName: 'tom',
      agendaFingerprint: 'agenda:v1:tom',
      reportToken: 'wrs:v1.tom',
    };

    await store.appendPendingReport(bobRequest, 'control_api_unavailable');
    await store.appendPendingReport(tomRequest, 'control_api_unavailable');
    await writeFile(
      join(root, 'team-a', 'members', 'bob', '.member-work-sync', 'reports.json'),
      JSON.stringify({ schemaVersion: 2, intents: {} }),
      'utf8'
    );

    const pending = await store.listPendingReports('team-a');
    expect(pending.map((intent) => intent.memberName)).toEqual(['tom']);
    const repaired = JSON.parse(
      await readFile(
        join(root, 'team-a', '.member-work-sync', 'indexes', 'pending-reports-index.json'),
        'utf8'
      )
    );
    expect(
      Object.values(repaired.items).map((item) => (item as { memberName: string }).memberName)
    ).toEqual(['tom']);
  });

  it('repairs a partially missing pending-report index route from member-scoped report files', async () => {
    const bobRequest = {
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working' as const,
      agendaFingerprint: 'agenda:v1:bob',
      reportToken: 'wrs:v1.bob',
      source: 'mcp' as const,
    };
    const tomRequest = {
      ...bobRequest,
      memberName: 'tom',
      agendaFingerprint: 'agenda:v1:tom',
      reportToken: 'wrs:v1.tom',
    };

    await store.appendPendingReport(bobRequest, 'control_api_unavailable');
    await store.appendPendingReport(tomRequest, 'control_api_unavailable');
    const indexPath = join(
      root,
      'team-a',
      '.member-work-sync',
      'indexes',
      'pending-reports-index.json'
    );
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    for (const [id, route] of Object.entries(index.items)) {
      if ((route as { memberName: string }).memberName === 'tom') {
        delete index.items[id];
      }
    }
    await writeFile(indexPath, JSON.stringify(index), 'utf8');

    const pending = await store.listPendingReports('team-a');
    expect(pending.map((intent) => intent.memberName).sort()).toEqual(['bob', 'tom']);
    const repaired = JSON.parse(await readFile(indexPath, 'utf8'));
    expect(
      Object.values(repaired.items)
        .map((item) => (item as { memberName: string }).memberName)
        .sort()
    ).toEqual(['bob', 'tom']);
  });

  it('records bounded shadow metrics from status writes', async () => {
    await store.write(makeStatus({}));
    await store.write(
      makeStatus({
        agenda: {
          teamName: 'team-a',
          memberName: 'bob',
          generatedAt: '2026-04-29T00:01:00.000Z',
          fingerprint: 'agenda:v1:def',
          items: [],
          diagnostics: [],
        },
        state: 'caught_up',
        shadow: {
          reconciledBy: 'request',
          wouldNudge: false,
          fingerprintChanged: true,
          previousFingerprint: 'agenda:v1:abc',
        },
        evaluatedAt: '2026-04-29T00:01:00.000Z',
      })
    );

    const metrics = await store.readTeamMetrics('team-a');
    expect(metrics).toMatchObject({
      teamName: 'team-a',
      memberCount: 1,
      actionableItemCount: 0,
      wouldNudgeCount: 1,
      fingerprintChangeCount: 1,
    });
    expect(metrics.stateCounts.caught_up).toBe(1);
    expect(metrics.recentEvents.map((event) => event.kind)).toEqual([
      'status_evaluated',
      'would_nudge',
      'status_evaluated',
      'fingerprint_changed',
    ]);
    expect(metrics.phase2Readiness).toMatchObject({
      state: 'collecting_shadow_data',
      reasons: expect.arrayContaining([
        'insufficient_status_events',
        'insufficient_observation_window',
      ]),
    });
  });

  it('deduplicates outbox items by id and rejects payload hash conflicts', async () => {
    const input = {
      id: 'member-work-sync:team-a:bob:agenda:v1:abc',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      nowIso: '2026-04-29T00:00:00.000Z',
    };

    await expect(store.ensurePending(input)).resolves.toMatchObject({
      ok: true,
      outcome: 'created',
      item: { status: 'pending', attemptGeneration: 0 },
    });
    await expect(store.ensurePending(input)).resolves.toMatchObject({
      ok: true,
      outcome: 'existing',
    });
    await expect(store.ensurePending({ ...input, payloadHash: 'hash-b' })).resolves.toMatchObject({
      ok: false,
      outcome: 'payload_conflict',
      existingPayloadHash: 'hash-a',
      requestedPayloadHash: 'hash-b',
    });
  });

  it('revives superseded outbox items but keeps delivered nudges one-per-fingerprint', async () => {
    const input = {
      id: 'member-work-sync:team-a:bob:agenda:v1:abc',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      nowIso: '2026-04-29T00:00:00.000Z',
    };

    await store.ensurePending(input);
    await store.markSuperseded({
      teamName: 'team-a',
      id: input.id,
      reason: 'status_no_longer_matches_outbox',
      nowIso: '2026-04-29T00:01:00.000Z',
    });

    const revived = await store.ensurePending({ ...input, nowIso: '2026-04-29T00:02:00.000Z' });
    expect(revived).toMatchObject({
      ok: true,
      outcome: 'existing',
      item: { status: 'pending' },
    });
    expect(revived.item).not.toHaveProperty('lastError');

    const [claimed] = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:03:00.000Z',
      limit: 1,
    });
    await store.markDelivered({
      teamName: 'team-a',
      id: input.id,
      attemptGeneration: claimed.attemptGeneration,
      deliveredMessageId: 'message-1',
      nowIso: '2026-04-29T00:04:00.000Z',
    });

    await expect(
      store.ensurePending({ ...input, nowIso: '2026-04-29T00:05:00.000Z' })
    ).resolves.toMatchObject({
      ok: true,
      outcome: 'existing',
      item: { status: 'delivered', deliveredMessageId: 'message-1' },
    });
  });

  it('finds recent recovery outbox rows by logical intent key', async () => {
    const olderInput = {
      id: 'member-work-sync:team-a:bob:agenda:v1:older',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:older',
      payloadHash: 'hash-older',
      payload: makeNudgePayload({ workSyncIntentKey: 'proof-missing:message-1' }),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    const latestInput = {
      ...olderInput,
      id: 'member-work-sync:team-a:bob:agenda:v1:latest',
      agendaFingerprint: 'agenda:v1:latest',
      payloadHash: 'hash-latest',
      nowIso: '2026-04-29T00:03:00.000Z',
    };
    const unrelatedInput = {
      ...olderInput,
      id: 'member-work-sync:team-a:bob:agenda:v1:unrelated',
      agendaFingerprint: 'agenda:v1:unrelated',
      payloadHash: 'hash-unrelated',
      payload: makeNudgePayload({ workSyncIntentKey: 'proof-missing:message-2' }),
      nowIso: '2026-04-29T00:04:00.000Z',
    };

    await store.ensurePending(olderInput);
    await store.ensurePending(latestInput);
    await store.ensurePending(unrelatedInput);

    await expect(
      store.findRecentRecoveryByIntent({
        teamName: 'team-a',
        memberName: 'bob',
        intentKey: 'proof-missing:message-1',
        sinceIso: '2026-04-29T00:01:00.000Z',
      })
    ).resolves.toMatchObject({
      id: latestInput.id,
      status: 'pending',
      payloadHash: 'hash-latest',
      updatedAt: '2026-04-29T00:03:00.000Z',
    });
  });

  it('ignores terminal and stale rows for logical recovery lookup', async () => {
    const input = {
      id: 'member-work-sync:team-a:bob:agenda:v1:terminal',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:terminal',
      payloadHash: 'hash-a',
      payload: makeNudgePayload({ workSyncIntentKey: 'proof-missing:message-1' }),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    await store.ensurePending(input);
    const [claimed] = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 1,
    });
    await store.markFailed({
      teamName: 'team-a',
      id: input.id,
      attemptGeneration: claimed.attemptGeneration,
      error: 'inbox_payload_conflict',
      retryable: false,
      nowIso: '2026-04-29T00:02:00.000Z',
    });

    await expect(
      store.findRecentRecoveryByIntent({
        teamName: 'team-a',
        memberName: 'bob',
        intentKey: 'proof-missing:message-1',
        sinceIso: '2026-04-29T00:00:00.000Z',
      })
    ).resolves.toBeNull();
    await expect(
      store.findRecentRecoveryByIntent({
        teamName: 'team-a',
        memberName: 'bob',
        intentKey: 'proof-missing:message-1',
        sinceIso: '2026-04-29T00:03:00.000Z',
      })
    ).resolves.toBeNull();
  });

  it('claims due outbox items and fences terminal updates by attempt generation', async () => {
    const input = {
      id: 'member-work-sync:team-a:bob:agenda:v1:abc',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    await store.ensurePending(input);

    const claimed = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 1,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: input.id,
      status: 'claimed',
      attemptGeneration: 1,
      claimedBy: 'dispatcher-a',
    });

    await store.markDelivered({
      teamName: 'team-a',
      id: input.id,
      attemptGeneration: 0,
      deliveredMessageId: 'wrong-generation',
      nowIso: '2026-04-29T00:02:00.000Z',
    });
    await expect(
      store.ensurePending({
        ...input,
        nowIso: '2026-04-29T00:03:00.000Z',
      })
    ).resolves.toMatchObject({
      ok: true,
      item: { status: 'pending', attemptGeneration: 1 },
    });

    const claimedAgain = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:04:00.000Z',
      limit: 1,
    });
    await store.markDelivered({
      teamName: 'team-a',
      id: input.id,
      attemptGeneration: claimedAgain[0].attemptGeneration,
      deliveredMessageId: 'message-1',
      nowIso: '2026-04-29T00:05:00.000Z',
    });

    const file = JSON.parse(
      await readFile(join(memberWorkSyncDir(root, 'team-a', 'bob'), 'outbox.json'), 'utf8')
    );
    expect(file.items[input.id]).toMatchObject({
      status: 'delivered',
      deliveredMessageId: 'message-1',
      attemptGeneration: 2,
    });
    const index = JSON.parse(
      await readFile(
        join(root, 'team-a', '.member-work-sync', 'indexes', 'outbox-index.json'),
        'utf8'
      )
    );
    expect(index.items[input.id]).toMatchObject({
      memberName: 'bob',
      status: 'delivered',
    });
  });

  it('claims due outbox items from the index without scanning unrelated member outboxes', async () => {
    const bobInput = {
      id: 'member-work-sync:team-a:bob:agenda:v1:abc',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    await store.ensurePending(bobInput);

    await mkdir(join(root, 'team-a', 'members', 'tom', '.member-work-sync'), { recursive: true });
    await writeFile(
      join(root, 'team-a', 'members', 'tom', 'member.meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        memberName: 'tom',
        memberKey: 'tom',
        updatedAt: '2026-04-29T00:00:00.000Z',
      }),
      'utf8'
    );
    await writeFile(
      join(root, 'team-a', 'members', 'tom', '.member-work-sync', 'outbox.json'),
      JSON.stringify({
        schemaVersion: 2,
        items: {
          'member-work-sync:team-a:tom:agenda:v1:other': {
            ...bobInput,
            id: 'member-work-sync:team-a:tom:agenda:v1:other',
            memberName: 'tom',
            status: 'pending',
            attemptGeneration: 0,
            createdAt: '2026-04-29T00:00:00.000Z',
            updatedAt: '2026-04-29T00:00:00.000Z',
          },
        },
      }),
      'utf8'
    );

    const claimed = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 1,
    });
    expect(claimed.map((item) => item.memberName)).toEqual(['bob']);
  });

  it('repairs a missing outbox index from member-scoped outbox files for delivered counts', async () => {
    const input = {
      id: 'member-work-sync:team-a:bob:agenda:v1:abc',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    await store.ensurePending(input);
    const [claimed] = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 1,
    });
    await store.markDelivered({
      teamName: 'team-a',
      id: input.id,
      attemptGeneration: claimed.attemptGeneration,
      deliveredMessageId: 'message-1',
      nowIso: '2026-04-29T00:02:00.000Z',
    });
    await rm(join(root, 'team-a', '.member-work-sync', 'indexes', 'outbox-index.json'), {
      force: true,
    });

    await expect(
      store.countRecentDelivered({
        teamName: 'team-a',
        memberName: 'bob',
        sinceIso: '2026-04-29T00:00:00.000Z',
      })
    ).resolves.toBe(1);
  });

  it('counts delivered nudges from the member outbox when the outbox index is partially stale', async () => {
    const bobInput = {
      id: 'member-work-sync:team-a:bob:agenda:v1:abc',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    const tomInput = {
      ...bobInput,
      id: 'member-work-sync:team-a:tom:agenda:v1:def',
      memberName: 'tom',
      payload: makeNudgePayload({ to: 'tom' }),
    };
    await store.ensurePending(bobInput);
    await store.ensurePending(tomInput);
    const [claimedBob] = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 1,
    });
    await store.markDelivered({
      teamName: 'team-a',
      id: bobInput.id,
      attemptGeneration: claimedBob.attemptGeneration,
      deliveredMessageId: 'message-1',
      nowIso: '2026-04-29T00:02:00.000Z',
    });

    const indexPath = join(root, 'team-a', '.member-work-sync', 'indexes', 'outbox-index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    delete index.items[bobInput.id];
    await writeFile(indexPath, JSON.stringify(index), 'utf8');

    await expect(
      store.countRecentDelivered({
        teamName: 'team-a',
        memberName: 'bob',
        sinceIso: '2026-04-29T00:00:00.000Z',
      })
    ).resolves.toBe(1);
    const repaired = JSON.parse(await readFile(indexPath, 'utf8'));
    expect(repaired.items[bobInput.id]).toMatchObject({ memberName: 'bob', status: 'delivered' });
  });

  it('finds delivered review pickup request event ids from member-scoped outbox files', async () => {
    const input = {
      id: 'member-work-sync:team-a:bob:review-pickup:evt-a+evt-b',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:review',
      payloadHash: 'hash-review',
      payload: makeNudgePayload({
        workSyncIntent: 'review_pickup',
        workSyncIntentKey: 'review-pickup:evt-a+evt-b',
        workSyncReviewRequestEventIds: ['evt-a', 'evt-b'],
      }),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    await store.ensurePending(input);
    const [claimed] = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 1,
    });
    await store.markDelivered({
      teamName: 'team-a',
      id: input.id,
      attemptGeneration: claimed.attemptGeneration,
      deliveredMessageId: 'message-1',
      deliveryState: 'prompt_accepted',
      nowIso: '2026-04-29T00:02:00.000Z',
    });

    await expect(
      store.findDeliveredReviewPickupRequestEventIds({
        teamName: 'team-a',
        memberName: 'bob',
        reviewRequestEventIds: ['evt-b', 'evt-c'],
      })
    ).resolves.toEqual(['evt-b']);
  });

  it('revives a claimed review pickup outbox item when only the payload text changed', async () => {
    const input = {
      id: 'member-work-sync:team-a:bob:review-pickup:evt-a',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:review-a',
      payloadHash: 'hash-review-a',
      payload: makeNudgePayload({
        workSyncIntent: 'review_pickup',
        workSyncIntentKey: 'review-pickup:evt-a',
        workSyncReviewRequestEventIds: ['evt-a'],
        text: 'Review pickup required: old subject',
      }),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    await store.ensurePending(input);
    const [claimed] = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 1,
    });
    expect(claimed.status).toBe('claimed');

    const result = await store.ensurePending({
      ...input,
      agendaFingerprint: 'agenda:v1:review-b',
      payloadHash: 'hash-review-b',
      payload: {
        ...input.payload,
        text: 'Review pickup required: renamed subject',
      },
      nowIso: '2026-04-29T00:02:00.000Z',
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: 'existing',
      item: {
        status: 'pending',
        agendaFingerprint: 'agenda:v1:review-b',
        payloadHash: 'hash-review-b',
        payload: {
          workSyncIntent: 'review_pickup',
          workSyncIntentKey: 'review-pickup:evt-a',
          text: 'Review pickup required: renamed subject',
        },
      },
    });
    const [reclaimed] = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-b',
      nowIso: '2026-04-29T00:03:00.000Z',
      limit: 1,
    });
    expect(reclaimed).toMatchObject({
      id: input.id,
      payloadHash: 'hash-review-b',
      payload: { text: 'Review pickup required: renamed subject' },
    });
  });

  it('repairs stale due outbox index routes before persisting claim results', async () => {
    const bobInput = {
      id: 'member-work-sync:team-a:bob:agenda:v1:abc',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    const tomInput = {
      ...bobInput,
      id: 'member-work-sync:team-a:tom:agenda:v1:def',
      memberName: 'tom',
      payload: makeNudgePayload({ to: 'tom' }),
    };
    await store.ensurePending(bobInput);
    await store.ensurePending(tomInput);
    await writeFile(
      join(root, 'team-a', 'members', 'bob', '.member-work-sync', 'outbox.json'),
      JSON.stringify({ schemaVersion: 2, items: {} }),
      'utf8'
    );

    const claimed = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 5,
    });
    expect(claimed.map((item) => item.memberName)).toEqual(['tom']);
    const repaired = JSON.parse(
      await readFile(
        join(root, 'team-a', '.member-work-sync', 'indexes', 'outbox-index.json'),
        'utf8'
      )
    );
    expect(
      Object.values(repaired.items).map((item) => (item as { memberName: string }).memberName)
    ).toEqual(['tom']);
  });

  it('repairs partially missing due outbox index routes before claiming', async () => {
    const bobInput = {
      id: 'member-work-sync:team-a:bob:agenda:v1:abc',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      nowIso: '2026-04-29T00:00:00.000Z',
    };
    const tomInput = {
      ...bobInput,
      id: 'member-work-sync:team-a:tom:agenda:v1:def',
      memberName: 'tom',
      payload: makeNudgePayload({ to: 'tom' }),
    };
    await store.ensurePending(bobInput);
    await store.ensurePending(tomInput);
    const indexPath = join(root, 'team-a', '.member-work-sync', 'indexes', 'outbox-index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    delete index.items[tomInput.id];
    await writeFile(indexPath, JSON.stringify(index), 'utf8');

    const claimed = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 5,
    });
    expect(claimed.map((item) => item.memberName).sort()).toEqual(['bob', 'tom']);
  });

  it('falls back to legacy v1 status and materializes legacy outbox during claim', async () => {
    const auditEvents: MemberWorkSyncAuditEvent[] = [];
    store = new JsonMemberWorkSyncStore(new MemberWorkSyncStorePaths(root), {
      auditJournal: {
        append: async (event) => {
          auditEvents.push(event);
        },
      },
      now: () => new Date('2026-04-29T00:02:00.000Z'),
    });
    const legacyStatusPath = join(root, 'team-a', '.member-work-sync', 'status.json');
    await mkdir(join(root, 'team-a', '.member-work-sync'), { recursive: true });
    await writeFile(
      legacyStatusPath,
      JSON.stringify({ schemaVersion: 1, members: { bob: makeStatus({}) } }),
      'utf8'
    );

    await expect(store.read({ teamName: 'team-a', memberName: 'bob' })).resolves.toMatchObject({
      memberName: 'bob',
      state: 'needs_sync',
    });

    const input = {
      id: 'member-work-sync:team-a:bob:agenda:v1:legacy',
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:legacy',
      payloadHash: 'hash-a',
      payload: makeNudgePayload(),
      status: 'pending' as const,
      attemptGeneration: 0,
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };
    await writeFile(
      join(root, 'team-a', '.member-work-sync', 'outbox.json'),
      JSON.stringify({ schemaVersion: 1, items: { [input.id]: input } }),
      'utf8'
    );

    const claimed = await store.claimDue({
      teamName: 'team-a',
      claimedBy: 'dispatcher-a',
      nowIso: '2026-04-29T00:01:00.000Z',
      limit: 1,
    });
    expect(claimed).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(join(memberWorkSyncDir(root, 'team-a', 'bob'), 'outbox.json'), 'utf8')
      ).items[input.id]
    ).toMatchObject({ status: 'claimed' });
    expect(auditEvents.map((event) => `${event.event}:${event.reason}`)).toEqual(
      expect.arrayContaining([
        'legacy_fallback_used:status_v1',
        'index_repaired:outbox',
        'legacy_fallback_used:outbox_v1',
      ])
    );
  });
});
