import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MEMBER_WORK_SYNC_ADMISSION_TICKET_FIELDS,
  buildMemberWorkSyncAdmissionPayloadHash,
  buildMemberWorkSyncNudgePayloadHash,
} from '@features/member-work-sync/core/domain';
import { NodeHashAdapter } from '@features/member-work-sync/main/infrastructure/NodeHashAdapter';

import type { MemberWorkSyncNudgePayload } from '@features/member-work-sync/contracts';

const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../src/features/member-work-sync/contracts/fixtures/work-sync-admission-hash.json'
    ),
    'utf8'
  )
) as { excludedAdmissionTicketFields: string[] };

describe('member work sync admission hash fixture', () => {
  const hash = new NodeHashAdapter();
  const base: MemberWorkSyncNudgePayload = {
    from: 'system',
    to: 'bob',
    messageKind: 'member_work_sync_nudge',
    source: 'member-work-sync',
    actionMode: 'do',
    workSyncIntent: 'agenda_sync',
    workSyncIntentKey: 'early-continuation:inc:agenda:runtime:1',
    workSyncControlRevision: 4,
    text: 'continue remaining work',
    taskRefs: [{ taskId: 'task-1', displayId: '11111111', teamName: 'team-a' }],
  };

  it('lists the exact ticket fields excluded from the admission hash', () => {
    expect(fixture.excludedAdmissionTicketFields).toEqual([...MEMBER_WORK_SYNC_ADMISSION_TICKET_FIELDS]);
  });

  it('keeps admission and full envelope hashes distinct', () => {
    const ticketed: MemberWorkSyncNudgePayload = {
      ...base,
      workSyncRuntimeTicketId: 'nonce-1',
      workSyncRuntimeGeneration: 2,
      workSyncRuntimeInstanceId: 'runtime-1',
      workSyncAdmissionPayloadHash: 'placeholder',
      workSyncTeamIncarnation: 'inc-1',
    };
    const admission = buildMemberWorkSyncAdmissionPayloadHash(hash, ticketed);
    const full = buildMemberWorkSyncNudgePayloadHash(hash, ticketed);
    expect(admission).not.toBe(full);
    expect(admission).toBe(buildMemberWorkSyncAdmissionPayloadHash(hash, base));
  });

  it('rejects a modified execution payload against the reserved admission hash', () => {
    const reserved = buildMemberWorkSyncAdmissionPayloadHash(hash, base);
    expect(
      buildMemberWorkSyncAdmissionPayloadHash(hash, { ...base, text: 'tampered' })
    ).not.toBe(reserved);
    expect(
      buildMemberWorkSyncAdmissionPayloadHash(hash, { ...base, workSyncControlRevision: 5 })
    ).not.toBe(reserved);
  });
});
