import { describe, expect, it } from 'vitest';

import {
  ACTUAL_OWNER_PURPOSE,
  EXPECTED_NEGATIVE_OUTCOMES,
  REQUIRED_NEGATIVE_CASES,
  REQUIRED_RESTART_CHECKPOINTS,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  validateActualOwnerCompletionEvidence,
  type ActualOwnerEvidenceDocument,
  type ActualOwnerTimelineEvent,
} from '../../../../scripts/e2e/hosted-actual-owner/evidence';

const allowId = 'approval_allow_12345678';
const denyId = 'approval_deny_12345678';
const ambiguousId = 'approval_ambiguous_12345678';

function event(
  approvalId: string,
  name: string,
  at: string,
  sequence: number
): ActualOwnerTimelineEvent {
  return Object.freeze({
    approvalId,
    at,
    event: name,
    generation: 'generation_1',
    runId: 'a'.repeat(48),
    sequence,
  });
}

function completeEvidence(): ActualOwnerEvidenceDocument {
  const repository = (root: string, head: string) => ({ root, head, status: 'clean' as const });
  const processEvidence = (name: 'opencode' | 'orchestrator' | 'product', index: number) => ({
    args: Object.freeze([]),
    executable: name === 'opencode' ? '/candidate/opencode' : `/usr/bin/${name}`,
    executableDevice: '1',
    executableInode: name === 'opencode' ? '2' : String(index),
    executableSha256: name === 'opencode' ? 'c'.repeat(64) : String(index).repeat(64).slice(0, 64),
    name,
    pid: 100 + index,
    processStartIdentity: String(1_000 + index),
    sourceRef:
      name === 'opencode'
        ? 'd'.repeat(40)
        : name === 'orchestrator'
          ? 'b'.repeat(40)
          : 'a'.repeat(40),
    uid: 1000,
  });
  const terminalEvents = (approvalId: string, offset: number) => [
    event(approvalId, 'completed', `2026-08-14T00:00:${30 + offset}.000Z`, 30 + offset),
  ];
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PURPOSE,
    runId: 'a'.repeat(48),
    status: 'running',
    refs: Object.freeze({
      product: repository('/product', 'a'.repeat(40)),
      productExecutable: Object.freeze({
        device: '1',
        executable: '/usr/bin/product',
        inode: '3',
        mode: 0o555,
        sha256: '3'.repeat(64),
        size: 100,
      }),
      orchestrator: repository('/orchestrator', 'b'.repeat(40)),
      artifact: Object.freeze({
        device: '1',
        executable: '/candidate/opencode',
        inode: '2',
        mode: 0o555,
        sha256: 'c'.repeat(64),
        size: 100,
        sourceCommit: 'd'.repeat(40),
      }),
    }),
    disk: Object.freeze({
      before: Object.freeze({ availableBytes: 10, freeBytes: 10, totalBytes: 20 }),
      after: Object.freeze({ availableBytes: 9, freeBytes: 9, totalBytes: 20 }),
    }),
    processIds: Object.freeze([
      processEvidence('opencode', 1),
      processEvidence('orchestrator', 2),
      processEvidence('product', 3),
    ]),
    timelines: Object.freeze({
      ownerWal: Object.freeze([
        event(allowId, 'ingress_durable', '2026-08-14T00:00:01.000Z', 1),
        event(denyId, 'ingress_durable', '2026-08-14T00:00:02.000Z', 2),
        ...terminalEvents(allowId, 0),
        event(denyId, 'rejected', '2026-08-14T00:00:31.000Z', 31),
      ]),
      product: Object.freeze([
        event(allowId, 'pending_durable', '2026-08-14T00:00:03.000Z', 3),
        event(denyId, 'pending_durable', '2026-08-14T00:00:04.000Z', 4),
        event(allowId, 'pending_durable_after_restart', '2026-08-14T00:00:05.000Z', 5),
        event(allowId, 'decision_committed', '2026-08-14T00:00:10.000Z', 10),
        event(denyId, 'decision_committed', '2026-08-14T00:00:11.000Z', 11),
        event(allowId, 'reconciled_terminal', '2026-08-14T00:00:40.000Z', 40),
        event(denyId, 'reconciled_terminal', '2026-08-14T00:00:41.000Z', 41),
      ]),
      openCode: Object.freeze([
        event(allowId, 'permission_settled', '2026-08-14T00:00:20.000Z', 20),
        event(denyId, 'permission_settled', '2026-08-14T00:00:21.000Z', 21),
      ]),
    }),
    postLedger: Object.freeze([
      Object.freeze({
        approvalId: allowId,
        at: '2026-08-14T00:00:15.000Z',
        bodySha256: '1'.repeat(64),
        conditional: true as const,
        decision: 'allow_once' as const,
        requestId: 'request_allow',
        responseClass: 'applied',
        sequence: 1,
        upstream: 'real_opencode' as const,
      }),
      ...REQUIRED_NEGATIVE_CASES.filter(
        (negative) =>
          negative.startsWith('http_') ||
          ['redirect', 'timeout', 'reset', 'malformed_response'].includes(negative)
      ).map((negative, index) =>
        Object.freeze({
          approvalId: `approval_negative_${negative}_12345678`,
          at: `2026-08-14T00:01:${String(index).padStart(2, '0')}.000Z`,
          bodySha256: String(index + 4)
            .repeat(64)
            .slice(0, 64),
          conditional: true as const,
          decision: 'allow_once' as const,
          requestId: `request_negative_${negative}`,
          responseClass: negative,
          sequence: index + 4,
          upstream: 'real_opencode' as const,
        })
      ),
      Object.freeze({
        approvalId: denyId,
        at: '2026-08-14T00:00:16.000Z',
        bodySha256: '2'.repeat(64),
        conditional: true as const,
        decision: 'reject' as const,
        requestId: 'request_deny',
        responseClass: 'applied',
        sequence: 2,
        upstream: 'real_opencode' as const,
      }),
      Object.freeze({
        approvalId: ambiguousId,
        at: '2026-08-14T00:00:17.000Z',
        bodySha256: '3'.repeat(64),
        conditional: true as const,
        decision: 'allow_once' as const,
        requestId: 'request_ambiguous',
        responseClass: 'reset_after_effect',
        sequence: 3,
        upstream: 'real_opencode' as const,
      }),
    ]),
    protectedEffectLedger: Object.freeze([
      Object.freeze({
        approvalId: allowId,
        effectCount: 1,
        effectSha256: '4'.repeat(64),
        kind: 'allow' as const,
      }),
      Object.freeze({
        approvalId: denyId,
        effectCount: 0,
        effectSha256: null,
        kind: 'deny' as const,
      }),
      Object.freeze({
        approvalId: ambiguousId,
        effectCount: 1,
        effectSha256: '5'.repeat(64),
        kind: 'ambiguous' as const,
      }),
      ...REQUIRED_NEGATIVE_CASES.map((negative) =>
        Object.freeze({
          approvalId: `approval_negative_${negative}_12345678`,
          effectCount: 0,
          effectSha256: null,
          kind: 'negative' as const,
        })
      ),
    ]),
    browserTracePath: '/evidence/browser-trace.zip',
    browser: Object.freeze({
      schemaVersion: 1,
      ownerAllow: Object.freeze({
        approvalId: allowId,
        clicked: true,
        pendingAfterRestart: true,
      }),
      ownerDeny: Object.freeze({ approvalId: denyId, clicked: true }),
      nonOwner: Object.freeze({ status: 403, postDelta: 0, effectDelta: 0 }),
      ambiguous: Object.freeze({
        approvalId: ambiguousId,
        automaticRetryPostDelta: 0,
        status: 'operator_required',
      }),
    }),
    restartMatrix: Object.freeze(
      REQUIRED_RESTART_CHECKPOINTS.map((checkpoint, index) =>
        Object.freeze({
          approvalId: `approval_restart_${index}_12345678`,
          checkpoint,
          duplicatePendingDelta: 0,
          postDelta: 0,
          survived: true,
        })
      )
    ),
    negatives: Object.freeze(
      REQUIRED_NEGATIVE_CASES.map((negative) =>
        Object.freeze({
          approvalId: `approval_negative_${negative}_12345678`,
          automaticRetryPostDelta: 0,
          case: negative,
          effectDelta: 0,
          outcome: EXPECTED_NEGATIVE_OUTCOMES[negative],
          attemptPostDelta:
            negative.startsWith('http_') ||
            ['redirect', 'timeout', 'reset', 'malformed_response'].includes(negative)
              ? 1
              : 0,
        })
      )
    ),
    cleanup: Object.freeze({
      attempted: true,
      markerVerified: true,
      removed: true,
      root: '/tmp/actual-owner',
      runId: 'a'.repeat(48),
      retainedReason: null,
    }),
    assertions: Object.freeze({ checked: false, violations: Object.freeze([]) }),
    failure: null,
  });
}

describe('actual-owner evidence invariants', () => {
  it('accepts complete durable, browser, exactly-once, restart, negative, and cleanup proof', () => {
    expect(validateActualOwnerCompletionEvidence(completeEvidence())).toEqual([]);
  });

  it('rejects a missing negative and an automatic retry of an ambiguous effect', () => {
    const evidence = completeEvidence();
    const ambiguousPost = evidence.postLedger.find((item) => item.approvalId === ambiguousId)!;
    const broken: ActualOwnerEvidenceDocument = {
      ...evidence,
      postLedger: Object.freeze([
        ...evidence.postLedger,
        { ...ambiguousPost, sequence: 100, at: '2026-08-14T00:00:18.000Z' },
      ]),
      negatives: Object.freeze(
        evidence.negatives.filter((item) => item.case !== 'session_rotation')
      ),
    };
    expect(validateActualOwnerCompletionEvidence(broken)).toEqual(
      expect.arrayContaining([
        'ambiguous_effect_retry_or_state_invalid',
        'negative_session_rotation_invalid',
      ])
    );
  });

  it('rejects decisions that precede durable WAL or product pending state', () => {
    const evidence = completeEvidence();
    const product = evidence.timelines.product.map((item) =>
      item.approvalId === allowId && item.event === 'decision_committed'
        ? { ...item, at: '2026-08-14T00:00:00.000Z' }
        : item
    );
    expect(
      validateActualOwnerCompletionEvidence({
        ...evidence,
        timelines: { ...evidence.timelines, product },
      })
    ).toContain('allow_pending_not_durable_before_decision');
  });
});
