import { describe, expect, it } from 'vitest';

import {
  buildMemberWorkSyncReviewPickupEscalationMessageId,
  buildMemberWorkSyncReviewPickupEscalationText,
} from '@main/services/team/escalation/memberWorkSyncReviewPickupEscalationMessage';

const baseInput = {
  teamName: 'alpha',
  memberName: 'Reviewer One',
  reason: 'review_pickup_already_delivered_still_stuck',
  reviewRequestEventIds: ['evt-2', 'evt-1'],
  taskRefs: [{ taskId: 'task-abcdef01', displayId: 'T-12' }],
};

describe('buildMemberWorkSyncReviewPickupEscalationMessageId', () => {
  it('produces a stable prefixed id', () => {
    const id = buildMemberWorkSyncReviewPickupEscalationMessageId(baseInput);
    expect(id).toMatch(/^member-work-sync-review-pickup-escalation:[0-9a-f]{20}$/);
  });

  it('is insensitive to member name casing, surrounding space and input ordering', () => {
    expect(
      buildMemberWorkSyncReviewPickupEscalationMessageId({
        ...baseInput,
        memberName: '  reviewer one  ',
        reviewRequestEventIds: ['evt-1', 'evt-2', 'evt-1'],
      })
    ).toBe(buildMemberWorkSyncReviewPickupEscalationMessageId(baseInput));
  });

  it('changes when the reason changes', () => {
    expect(
      buildMemberWorkSyncReviewPickupEscalationMessageId({
        ...baseInput,
        reason: 'review_pickup_delivery_failed_still_stuck',
      })
    ).not.toBe(buildMemberWorkSyncReviewPickupEscalationMessageId(baseInput));
  });
});

describe('buildMemberWorkSyncReviewPickupEscalationText', () => {
  it('lists the task display ids and describes the reason', () => {
    const text = buildMemberWorkSyncReviewPickupEscalationText(baseInput);
    expect(text).toContain('Review pickup needs lead attention.');
    expect(text).toContain('Reviewer: Reviewer One');
    expect(text).toContain('- T-12');
    expect(text).toContain(
      'A review-pickup reminder was delivered, but the review is still waiting for a review tool action.'
    );
  });

  it('falls back to a truncated task id and reports missing task refs', () => {
    expect(
      buildMemberWorkSyncReviewPickupEscalationText({
        ...baseInput,
        taskRefs: [{ taskId: 'task-abcdef01' }],
      })
    ).toContain('- task-abc');
    expect(buildMemberWorkSyncReviewPickupEscalationText({ ...baseInput, taskRefs: [] })).toContain(
      '- No task refs recorded'
    );
  });

  it('describes provider, delivery-port and generic reasons', () => {
    expect(
      buildMemberWorkSyncReviewPickupEscalationText({
        ...baseInput,
        reason: 'provider_not_supported:opencode',
      })
    ).toContain(
      'Direct review-pickup wake is not available for this member runtime, so the lead needs to handle the stuck review.'
    );
    expect(
      buildMemberWorkSyncReviewPickupEscalationText({
        ...baseInput,
        reason: 'member_delivery_port_unavailable',
      })
    ).toContain('No reliable review-pickup delivery path is available for this member runtime.');
    expect(
      buildMemberWorkSyncReviewPickupEscalationText({ ...baseInput, reason: 'something_else' })
    ).toContain('The current review request is still waiting for explicit review pickup.');
  });
});
