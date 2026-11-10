import { describe, expect, it } from 'vitest';

import {
  buildMemberWorkSyncAdmissionPayloadHash,
  buildMemberWorkSyncNudgePayloadHash,
} from '@features/member-work-sync/core/domain/MemberWorkSyncNudge';

import type { MemberWorkSyncNudgePayload } from '@features/member-work-sync/contracts';

const hash = {
  sha256Hex: (value: string) => `sha:${value}`,
};

describe('work-sync admission vs envelope hashes', () => {
  it('keeps the pre-ticket admission hash distinct from the full envelope hash', () => {
    const execution: MemberWorkSyncNudgePayload = {
      from: 'system',
      to: 'bob',
      messageKind: 'member_work_sync_nudge',
      source: 'member-work-sync',
      actionMode: 'do',
      workSyncIntent: 'agenda_sync',
      workSyncIntentKey: 'early-continuation:inc:agenda:runtime:1',
      workSyncControlRevision: 4,
      text: 'continue remaining work',
      taskRefs: [],
    };
    const admission = buildMemberWorkSyncAdmissionPayloadHash(hash, execution);
    const ticketed: MemberWorkSyncNudgePayload = {
      ...execution,
      workSyncRuntimeTicketId: 'nonce-1',
      workSyncRuntimeGeneration: 1,
      workSyncRuntimeInstanceId: 'runtime-1',
      workSyncAdmissionPayloadHash: admission,
    };
    const full = buildMemberWorkSyncNudgePayloadHash(hash, ticketed);
    expect(admission).not.toBe(full);
    expect(buildMemberWorkSyncAdmissionPayloadHash(hash, ticketed)).toBe(admission);
  });
});
