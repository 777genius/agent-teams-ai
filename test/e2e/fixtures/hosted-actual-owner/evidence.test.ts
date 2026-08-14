import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ACTUAL_OWNER_CONTRACT_BYTE_COUNT,
  ACTUAL_OWNER_CONTRACT_GIT_BLOB,
  ACTUAL_OWNER_CONTRACT_SHA256,
  ACTUAL_OWNER_PURPOSE,
  type ActualOwnerApprovalTimelineEventName,
  type ActualOwnerTimelineEvent,
  EXPECTED_NEGATIVE_OUTCOMES,
  REQUIRED_NEGATIVE_CASES,
  REQUIRED_RESTART_CHECKPOINTS,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  type ActualOwnerEvidenceDocument,
  validateActualOwnerCompletionEvidence,
} from '../../../../scripts/e2e/hosted-actual-owner/evidence';

const allowId = 'approval_allow_12345678';
const denyId = 'approval_deny_12345678';
const ambiguousId = 'approval_ambiguous_12345678';

function event(
  approvalId: string,
  name: ActualOwnerApprovalTimelineEventName,
  at: string,
  sequence: number
): ActualOwnerTimelineEvent {
  const requestId =
    approvalId === allowId
      ? 'request_allow'
      : approvalId === denyId
        ? 'request_deny'
        : approvalId === ambiguousId
          ? 'request_ambiguous'
          : approvalId.startsWith('approval_negative_')
            ? `request_${approvalId.slice('approval_'.length).replace(/_12345678$/u, '')}`
            : `request_${approvalId.slice('approval_'.length)}`;
  const effectId =
    approvalId === allowId
      ? 'effect_allow_12345678'
      : approvalId === ambiguousId
        ? 'effect_ambiguous_12345678'
        : null;
  return Object.freeze({
    schemaVersion: 1,
    approvalId,
    at,
    effectId,
    event: name,
    generation: 'generation_1',
    requestId,
    routeId: 'route_approval_decision',
    runId: 'a'.repeat(48),
    sequence,
    sessionId: `session_${'a'.repeat(48)}`,
  });
}

function completeEvidence(): ActualOwnerEvidenceDocument {
  const repository = (root: string, head: string) => ({ root, head, status: 'clean' as const });
  const sourceFile = (path: string, mode = 0o500, sourceCommit = 'b'.repeat(40)) => ({
    device: '1',
    gitBlob: '8'.repeat(40),
    inode: '9',
    mode,
    path,
    repositoryPath: path.split('/').at(-1) as string,
    sha256: '9'.repeat(64),
    size: 100,
    sourceCommit,
  });
  const processEvidence = (name: 'opencode' | 'orchestrator' | 'product', index: number) => ({
    args: Object.freeze([]),
    executable:
      name === 'orchestrator'
        ? '/usr/bin/orchestrator'
        : `/tmp/actual-owner/runtime/descriptor-bound-executables/${name}-candidate`,
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
        ctimeNs: '1',
        device: '1',
        executable: '/usr/bin/product',
        gid: '1000',
        inode: '3',
        mode: 0o555,
        mtimeNs: '1',
        nlink: '1',
        sha256: '3'.repeat(64),
        size: 100,
        sourceCommit: 'a'.repeat(40),
        uid: '1000',
      }),
      productContractSource: {
        ...sourceFile(
          '/product/scripts/e2e/hosted-actual-owner/actual-owner-contract.v1.json',
          0o400,
          'a'.repeat(40)
        ),
        gitBlob: ACTUAL_OWNER_CONTRACT_GIT_BLOB,
        sha256: ACTUAL_OWNER_CONTRACT_SHA256,
        size: ACTUAL_OWNER_CONTRACT_BYTE_COUNT,
      },
      productContractStaged: {
        ...sourceFile(
          '/tmp/actual-owner/runtime/descriptor-bound-sources/product-contract-source',
          0o400,
          'a'.repeat(40)
        ),
        gitBlob: ACTUAL_OWNER_CONTRACT_GIT_BLOB,
        sha256: ACTUAL_OWNER_CONTRACT_SHA256,
        size: ACTUAL_OWNER_CONTRACT_BYTE_COUNT,
      },
      orchestrator: repository('/orchestrator', 'b'.repeat(40)),
      orchestratorLauncherSource: sourceFile('/orchestrator/cli-source'),
      orchestratorAcceptanceSource: sourceFile('/orchestrator/owner.ts'),
      orchestratorLauncherStaged: sourceFile(
        '/tmp/actual-owner/runtime/descriptor-bound-sources/orchestrator-launcher-source'
      ),
      orchestratorAcceptanceStaged: sourceFile(
        '/tmp/actual-owner/runtime/descriptor-bound-sources/orchestrator-entry-source',
        0o400
      ),
      artifact: Object.freeze({
        ctimeNs: '1',
        device: '1',
        executable: '/candidate/opencode',
        gid: '1000',
        inode: '2',
        mode: 0o555,
        mtimeNs: '1',
        nlink: '1',
        sha256: 'c'.repeat(64),
        size: 100,
        sourceCommit: 'd'.repeat(40),
        uid: '1000',
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
    capability: Object.freeze({
      checkedAt: '2026-08-14T00:00:00.000Z',
      contractSha256: ACTUAL_OWNER_CONTRACT_SHA256,
      driverSocket: Object.freeze({
        device: '8',
        endpoint: '127.0.0.1:49152',
        inode: '8001',
        ownerSessionId: `session_${'a'.repeat(48)}`,
      }),
      markerPath: '/tmp/actual-owner/.agent-teams-actual-owner-e2e-owner.json',
      noFakeRuntime: true,
      ownerSessionId: `session_${'a'.repeat(48)}`,
      productSocket: Object.freeze({
        device: '8',
        endpoint: '127.0.0.1:49153',
        inode: '8002',
        ownerSessionId: `session_${'a'.repeat(48)}`,
      }),
      refsSha256: createHash('sha256')
        .update(
          JSON.stringify({
            openCode: 'd'.repeat(40),
            openCodeExecutableSha256: 'c'.repeat(64),
            orchestrator: 'b'.repeat(40),
            product: 'a'.repeat(40),
          })
        )
        .digest('hex'),
    }),
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
        event(ambiguousId, 'decision_committed', '2026-08-14T00:00:13.000Z', 13),
        event(allowId, 'reconciled_terminal', '2026-08-14T00:00:40.000Z', 40),
        event(denyId, 'reconciled_terminal', '2026-08-14T00:00:41.000Z', 41),
        ...REQUIRED_RESTART_CHECKPOINTS.map((checkpoint, index) =>
          event(
            `approval_restart_${index}_12345678`,
            `restart_checkpoint:${checkpoint}`,
            `2026-08-14T00:02:${String(index).padStart(2, '0')}.000Z`,
            100 + index
          )
        ),
        ...REQUIRED_NEGATIVE_CASES.map((negative, index) =>
          event(
            `approval_negative_${negative}_12345678`,
            `negative_observed:${negative}:${EXPECTED_NEGATIVE_OUTCOMES[negative]}`,
            `2026-08-14T00:03:${String(index).padStart(2, '0')}.000Z`,
            200 + index
          )
        ),
      ]),
      openCode: Object.freeze([
        event(allowId, 'permission_settled', '2026-08-14T00:00:20.000Z', 20),
        event(denyId, 'permission_settled', '2026-08-14T00:00:21.000Z', 21),
      ]),
    }),
    timelineCaptures: Object.freeze({
      ownerWal: Object.freeze({
        byteCount: 100,
        ctimeNs: '1',
        device: '1',
        inode: '11',
        mtimeNs: '1',
        path: '/capture/owner-wal.ndjson',
        sha256: 'a'.repeat(64),
      }),
      product: Object.freeze({
        byteCount: 100,
        ctimeNs: '1',
        device: '1',
        inode: '12',
        mtimeNs: '1',
        path: '/capture/product.ndjson',
        sha256: 'b'.repeat(64),
      }),
      openCode: Object.freeze({
        byteCount: 100,
        ctimeNs: '1',
        device: '1',
        inode: '13',
        mtimeNs: '1',
        path: '/capture/opencode.ndjson',
        sha256: 'c'.repeat(64),
      }),
    }),
    postLedger: Object.freeze([
      Object.freeze({
        actionNonceSha256: '6'.repeat(64),
        approvalId: allowId,
        at: '2026-08-14T00:00:15.000Z',
        bodySha256: '1'.repeat(64),
        conditional: true as const,
        decision: 'allow_once' as const,
        effectId: 'effect_allow_12345678',
        generation: 'generation_1',
        requestId: 'request_allow',
        routeId: 'route_approval_decision',
        responseClass: 'applied',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
        sequence: 1,
        upstream: 'real_opencode' as const,
      }),
      ...REQUIRED_NEGATIVE_CASES.filter(
        (negative) =>
          negative.startsWith('http_') ||
          ['redirect', 'timeout', 'reset', 'malformed_response'].includes(negative)
      ).map((negative, index) =>
        Object.freeze({
          actionNonceSha256: createHash('sha256').update(negative).digest('hex'),
          approvalId: `approval_negative_${negative}_12345678`,
          at: `2026-08-14T00:01:${String(index).padStart(2, '0')}.000Z`,
          bodySha256: String(index + 4)
            .repeat(64)
            .slice(0, 64),
          conditional: true as const,
          decision: 'allow_once' as const,
          effectId: null,
          generation: 'generation_1',
          requestId: `request_negative_${negative}`,
          routeId: 'route_approval_decision',
          responseClass: negative,
          runId: 'a'.repeat(48),
          sessionId: `session_${'a'.repeat(48)}`,
          sequence: index + 4,
          upstream: 'real_opencode' as const,
        })
      ),
      Object.freeze({
        actionNonceSha256: '7'.repeat(64),
        approvalId: denyId,
        at: '2026-08-14T00:00:16.000Z',
        bodySha256: '2'.repeat(64),
        conditional: true as const,
        decision: 'reject' as const,
        effectId: null,
        generation: 'generation_1',
        requestId: 'request_deny',
        routeId: 'route_approval_decision',
        responseClass: 'applied',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
        sequence: 2,
        upstream: 'real_opencode' as const,
      }),
      Object.freeze({
        actionNonceSha256: '8'.repeat(64),
        approvalId: ambiguousId,
        at: '2026-08-14T00:00:17.000Z',
        bodySha256: '3'.repeat(64),
        conditional: true as const,
        decision: 'allow_once' as const,
        effectId: 'effect_ambiguous_12345678',
        generation: 'generation_1',
        requestId: 'request_ambiguous',
        routeId: 'route_approval_decision',
        responseClass: 'reset_after_effect',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
        sequence: 3,
        upstream: 'real_opencode' as const,
      }),
    ]),
    protectedEffectLedger: Object.freeze([
      Object.freeze({
        actionNonceSha256: '6'.repeat(64),
        approvalId: allowId,
        at: '2026-08-14T00:00:18.000Z',
        decisionBodySha256: '1'.repeat(64),
        effectCount: 1,
        effectId: 'effect_allow_12345678',
        effectSha256: '4'.repeat(64),
        generation: 'generation_1',
        kind: 'allow' as const,
        requestId: 'request_allow',
        routeId: 'route_approval_decision',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
      }),
      Object.freeze({
        actionNonceSha256: '7'.repeat(64),
        approvalId: denyId,
        at: '2026-08-14T00:00:19.000Z',
        decisionBodySha256: '2'.repeat(64),
        effectCount: 0,
        effectId: null,
        effectSha256: null,
        generation: 'generation_1',
        kind: 'deny' as const,
        requestId: 'request_deny',
        routeId: 'route_approval_decision',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
      }),
      Object.freeze({
        actionNonceSha256: '8'.repeat(64),
        approvalId: ambiguousId,
        at: '2026-08-14T00:00:19.500Z',
        decisionBodySha256: '3'.repeat(64),
        effectCount: 1,
        effectId: 'effect_ambiguous_12345678',
        effectSha256: '5'.repeat(64),
        generation: 'generation_1',
        kind: 'ambiguous' as const,
        requestId: 'request_ambiguous',
        routeId: 'route_approval_decision',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
      }),
      ...REQUIRED_NEGATIVE_CASES.map((negative) =>
        Object.freeze({
          actionNonceSha256: createHash('sha256').update(negative).digest('hex'),
          approvalId: `approval_negative_${negative}_12345678`,
          at: '2026-08-14T00:04:00.000Z',
          decisionBodySha256: null,
          effectCount: 0,
          effectId: null,
          effectSha256: null,
          generation: 'generation_1',
          kind: 'negative' as const,
          requestId: `request_negative_${negative}`,
          routeId: 'route_approval_decision',
          runId: 'a'.repeat(48),
          sessionId: `session_${'a'.repeat(48)}`,
        })
      ),
    ]),
    browserTracePath: '/evidence/browser-trace.zip',
    browser: Object.freeze({
      schemaVersion: 1,
      ownerWalAuthority: Object.freeze({
        authority: 'product-owner-wal' as const,
        byteCount: 100,
        ctimeNs: '1',
        device: '1',
        inode: '11',
        mtimeNs: '1',
        ownerSessionId: `session_${'a'.repeat(48)}`,
        sha256: 'a'.repeat(64),
        signature: 'f'.repeat(64),
        size: 100,
      }),
      ownerAllow: Object.freeze({
        actionNonceSha256: '6'.repeat(64),
        approvalId: allowId,
        bodySha256: '1'.repeat(64),
        clicked: true,
        clickedAt: '2026-08-14T00:00:09.000Z',
        decision: 'allow_once' as const,
        effectId: 'effect_allow_12345678',
        generation: 'generation_1',
        pendingAfterRestart: true,
        requestId: 'request_allow',
        routeId: 'route_approval_decision',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
      }),
      ownerDeny: Object.freeze({
        actionNonceSha256: '7'.repeat(64),
        approvalId: denyId,
        bodySha256: '2'.repeat(64),
        clicked: true,
        clickedAt: '2026-08-14T00:00:10.000Z',
        decision: 'reject' as const,
        effectId: null,
        generation: 'generation_1',
        requestId: 'request_deny',
        routeId: 'route_approval_decision',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
      }),
      nonOwner: Object.freeze({ status: 403, postDelta: 0, effectDelta: 0 }),
      ambiguous: Object.freeze({
        actionNonceSha256: '8'.repeat(64),
        approvalId: ambiguousId,
        automaticRetryPostDelta: 0,
        bodySha256: '3'.repeat(64),
        clicked: true,
        clickedAt: '2026-08-14T00:00:12.000Z',
        decision: 'allow_once' as const,
        effectId: 'effect_ambiguous_12345678',
        generation: 'generation_1',
        requestId: 'request_ambiguous',
        routeId: 'route_approval_decision',
        runId: 'a'.repeat(48),
        sessionId: `session_${'a'.repeat(48)}`,
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

  it('rejects an unscoped or duplicate protected-effect proof', () => {
    const evidence = completeEvidence();
    expect(
      validateActualOwnerCompletionEvidence({
        ...evidence,
        protectedEffectLedger: Object.freeze([
          ...evidence.protectedEffectLedger,
          Object.freeze({
            actionNonceSha256: '9'.repeat(64),
            approvalId: 'approval_unscoped_12345678',
            at: '2026-08-14T00:04:00.000Z',
            decisionBodySha256: null,
            effectCount: 0,
            effectId: null,
            effectSha256: null,
            generation: 'generation_1',
            kind: 'negative' as const,
            requestId: 'request_unscoped',
            routeId: 'route_approval_decision',
            runId: 'a'.repeat(48),
            sessionId: `session_${'a'.repeat(48)}`,
          }),
        ]),
      })
    ).toContain('protected_effect_ledger_scope_invalid');
  });

  it('rejects a fabricated click or unrelated effect ledger identity', () => {
    const evidence = completeEvidence();
    expect(
      validateActualOwnerCompletionEvidence({
        ...evidence,
        browser: {
          ...evidence.browser!,
          ownerAllow: { ...evidence.browser!.ownerAllow, requestId: 'request_unrelated' },
        },
      })
    ).toContain('browser_decision_effect_causality_invalid');
    expect(
      validateActualOwnerCompletionEvidence({
        ...evidence,
        protectedEffectLedger: evidence.protectedEffectLedger.map((item) =>
          item.approvalId === allowId ? { ...item, decisionBodySha256: 'f'.repeat(64) } : item
        ),
      })
    ).toContain('browser_decision_effect_causality_invalid');
  });

  it('rejects reused action nonces, aliased sockets, and unsigned owner-WAL identity drift', () => {
    const evidence = completeEvidence();
    expect(
      validateActualOwnerCompletionEvidence({
        ...evidence,
        browser: {
          ...evidence.browser!,
          ownerDeny: {
            ...evidence.browser!.ownerDeny,
            actionNonceSha256: evidence.browser!.ownerAllow.actionNonceSha256,
          },
        },
      })
    ).toContain('browser_decision_effect_causality_invalid');
    expect(
      validateActualOwnerCompletionEvidence({
        ...evidence,
        capability: {
          ...evidence.capability!,
          productSocket: evidence.capability!.driverSocket,
        },
      })
    ).toContain('capability_observation_invalid');
    expect(
      validateActualOwnerCompletionEvidence({
        ...evidence,
        browser: {
          ...evidence.browser!,
          ownerWalAuthority: {
            ...evidence.browser!.ownerWalAuthority,
            sha256: '0'.repeat(64),
          },
        },
      })
    ).toContain('owner_wal_raw_authority_invalid');
  });
});
