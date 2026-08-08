import {
  buildMemberWorkSyncNudgePayload,
  buildMemberWorkSyncOutboxEnsureInput,
} from '@features/member-work-sync/core/domain';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

function makeStatus(overrides: Partial<MemberWorkSyncStatus> = {}): MemberWorkSyncStatus {
  return {
    teamName: 'sable-ops',
    memberName: 'team-lead',
    state: 'needs_sync',
    agenda: {
      teamName: 'sable-ops',
      memberName: 'team-lead',
      generatedAt: '2026-05-13T13:02:44.263Z',
      fingerprint: 'agenda:v1:test',
      diagnostics: [],
      items: [
        {
          taskId: 'task-review-path',
          displayId: 'c3add790',
          subject: 'Проверить калькулятор и дать ревью',
          assignee: 'team-lead',
          kind: 'clarification',
          priority: 'needs_clarification',
          reason: 'task_needs_lead_clarification',
          evidence: {
            status: 'in_progress',
            owner: 'alice',
            needsClarification: 'lead',
          },
        },
      ],
    },
    evaluatedAt: '2026-05-13T13:02:44.291Z',
    diagnostics: ['no_current_report'],
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: true,
      fingerprintChanged: false,
    },
    providerId: 'codex',
    ...overrides,
  };
}

describe('MemberWorkSyncNudge', () => {
  it('tells lead to move escalated clarification to user on the board', () => {
    const payload = buildMemberWorkSyncNudgePayload(makeStatus());

    expect(payload.text).toContain('mcp__agent-teams__member_work_sync_status');
    expect(payload.text).toContain('A status-only tool call is incomplete');
    expect(payload.text).toContain(
      'update the task board first with task_set_clarification value "user"'
    );
    expect(payload.text).toContain('do not rely on a message alone');
  });

  it('does not add clarification board-transition guidance for normal work', () => {
    const payload = buildMemberWorkSyncNudgePayload(
      makeStatus({
        memberName: 'bob',
        agenda: {
          teamName: 'sable-ops',
          memberName: 'bob',
          generatedAt: '2026-05-13T13:02:44.263Z',
          fingerprint: 'agenda:v1:work',
          diagnostics: [],
          items: [
            {
              taskId: 'task-work',
              displayId: 'c76d04cc',
              subject: 'Создать каркас калькулятора',
              assignee: 'bob',
              kind: 'work',
              priority: 'normal',
              reason: 'owned_pending_task',
              evidence: {
                status: 'pending',
                owner: 'bob',
              },
            },
          ],
        },
      })
    );

    expect(payload.text).not.toContain('task_set_clarification value "user"');
  });

  it('marks review-pickup status-only tool calls as incomplete', () => {
    const payload = buildMemberWorkSyncNudgePayload(
      makeStatus({
        memberName: 'bob',
        agenda: {
          teamName: 'sable-ops',
          memberName: 'bob',
          generatedAt: '2026-05-13T13:02:44.263Z',
          fingerprint: 'agenda:v1:review',
          diagnostics: [],
          items: [
            {
              taskId: 'task-review',
              displayId: '22222222',
              subject: 'Review docs',
              assignee: 'bob',
              kind: 'review',
              priority: 'review_requested',
              reason: 'current_cycle_review_assigned',
              evidence: {
                status: 'completed',
                owner: 'alice',
                reviewer: 'bob',
                reviewState: 'review',
                reviewCycleId: 'evt-review-request',
                reviewRequestEventId: 'evt-review-request',
                reviewObligation: 'review_pickup_required',
                canBypassDeliveryReadiness: true,
              },
            },
          ],
        },
      })
    );

    expect(payload.workSyncIntent).toBe('review_pickup');
    expect(payload.text).toContain('A status-only tool call is incomplete');
    expect(payload.text).toContain('mcp__agent-teams__member_work_sync_report');
  });

  it('adds proof-missing recovery context to agenda sync nudges', () => {
    const status = makeStatus({
      memberName: 'bob',
      agenda: {
        teamName: 'sable-ops',
        memberName: 'bob',
        generatedAt: '2026-05-13T13:02:44.263Z',
        fingerprint: 'agenda:v1:work',
        diagnostics: [],
        items: [
          {
            taskId: 'task-work',
            displayId: 'c76d04cc',
            subject: 'Создать каркас калькулятора',
            assignee: 'bob',
            kind: 'work',
            priority: 'normal',
            reason: 'owned_pending_task',
            evidence: {
              status: 'pending',
              owner: 'bob',
            },
          },
        ],
      },
      shadow: {
        reconciledBy: 'queue',
        wouldNudge: true,
        fingerprintChanged: false,
        recovery: {
          kind: 'proof_missing',
          intentKey: 'proof-missing:message-1',
          originalMessageId: 'message-1',
          taskIds: ['task-work'],
        },
      },
    });
    const payload = buildMemberWorkSyncNudgePayload(status);
    const outboxInput = buildMemberWorkSyncOutboxEnsureInput({
      status,
      nowIso: status.evaluatedAt,
      hash: {
        sha256Hex: (value) => `hash:${value.length}`,
      },
    });

    expect(payload.workSyncIntent).toBe('agenda_sync');
    expect(payload.workSyncIntentKey).toBe('proof-missing:message-1');
    expect(payload.text).toContain(
      'repairs OpenCode delivery proof for original messageId "message-1"'
    );
    expect(payload.text).toContain('do not duplicate it');
    expect(outboxInput?.id).toBe('member-work-sync:sable-ops:bob:proof-missing:message-1');
  });
});
