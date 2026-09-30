import { createHash } from 'node:crypto';

import { parseRunId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import { memberStartOperationId, resolveFrozenMemberStart } from './hostedMemberStartResolution';

import type { HostedLifecycleRunReservation } from '@features/internal-storage/contracts';

const RUN_ID = `run_${'b'.repeat(32)}`;
const MEMBER_ID = `member_${'f'.repeat(32)}`;
const PLAN_SHA = 'd'.repeat(64);
const PROMOTION_ID = `promotion_${'a'.repeat(32)}`;
const ROSTER = {
  schemaVersion: 1,
  operationId: PROMOTION_ID,
  planSha256: PLAN_SHA,
  lanes: [
    {
      laneOrdinal: 0,
      laneId: `lane_${'c'.repeat(32)}`,
      members: [
        {
          memberOrdinal: 0,
          memberId: MEMBER_ID,
          name: 'Reviewer',
          model: 'openai/gpt-5.1-codex',
          promptSha256: 'e'.repeat(64),
        },
      ],
    },
  ],
} as const;
const ROSTER_SHA = createHash('sha256').update(JSON.stringify(ROSTER)).digest('hex');
const RESERVATION = {
  runId: RUN_ID,
  promotionOperationId: PROMOTION_ID,
  planSha256: PLAN_SHA,
  expectedPlanGeneration: `plan-generation_${PLAN_SHA}`,
  rosterBindingSha256: ROSTER_SHA,
} as HostedLifecycleRunReservation;

describe('frozen member start resolution', () => {
  it('matches the Owner member-start golden vector', () => {
    expect(memberStartOperationId(RUN_ID, MEMBER_ID, PLAN_SHA)).toBe(
      'start_89fca1ff37e680c24c36381ab6a78ba1da0ee332c520cff5625c74720bd90459'
    );
    expect(
      memberStartOperationId(`run_${'0'.repeat(32)}`, `member_${'1'.repeat(32)}`, '2'.repeat(64))
    ).toBe('start_e3719c057956a13afa259e4e08162e3079702ccec89e23ee5485abf31f4dadb7');
  });

  it('selects one immutable roster member bound to the reserved run', () => {
    const selected = resolveFrozenMemberStart(RESERVATION, ROSTER, RUN_ID, MEMBER_ID);
    expect(selected).toEqual({
      operationId: memberStartOperationId(RUN_ID, MEMBER_ID, PLAN_SHA),
      runId: RUN_ID,
      memberId: MEMBER_ID,
      planSha256: PLAN_SHA,
      laneId: ROSTER.lanes[0].laneId,
      memberName: 'Reviewer',
      memberOrdinal: 0,
      model: 'openai/gpt-5.1-codex',
      promptSha256: 'e'.repeat(64),
    });
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it('rejects invalid selectors and a member absent from the frozen roster', () => {
    expect(() => memberStartOperationId('run_1', MEMBER_ID, PLAN_SHA)).toThrow();
    expect(() => memberStartOperationId(RUN_ID, 'member_1', PLAN_SHA)).toThrow();
    expect(() => memberStartOperationId(RUN_ID, MEMBER_ID, PLAN_SHA.toUpperCase())).toThrow();
    expect(() =>
      resolveFrozenMemberStart(RESERVATION, ROSTER, RUN_ID, `member_${'1'.repeat(32)}`)
    ).toThrow('member-start-frozen-member-unavailable');
  });

  it('rejects run, promotion, plan, and roster digest mismatches', () => {
    for (const changed of [
      { ...RESERVATION, runId: parseRunId(`run_${'1'.repeat(32)}`) },
      { ...RESERVATION, promotionOperationId: `promotion_${'1'.repeat(32)}` },
      { ...RESERVATION, planSha256: '1'.repeat(64) },
      { ...RESERVATION, rosterBindingSha256: '1'.repeat(64) },
    ]) {
      expect(() => resolveFrozenMemberStart(changed, ROSTER, RUN_ID, MEMBER_ID)).toThrow(
        'member-start-frozen-binding-mismatch'
      );
    }
    expect(() =>
      resolveFrozenMemberStart(
        RESERVATION,
        {
          ...ROSTER,
          lanes: [
            { ...ROSTER.lanes[0], members: [{ ...ROSTER.lanes[0].members[0], name: 'Other' }] },
          ],
        },
        RUN_ID,
        MEMBER_ID
      )
    ).toThrow('member-start-frozen-binding-mismatch');
  });
});
