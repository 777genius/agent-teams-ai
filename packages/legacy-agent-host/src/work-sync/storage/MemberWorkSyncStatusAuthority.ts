import { MemberWorkSyncReportReceiptError } from '../policy/core/domain/MemberWorkSyncReportReceipt.js';
import { MemberWorkSyncStatusConflictError } from '../policy/core/domain/MemberWorkSyncStatusRevision.js';

import {
  decodeMemberWorkSyncStoredStatus,
  MemberWorkSyncStatusDecodeError,
} from './decodeMemberWorkSyncStoredStatus.js';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson.js';
import {
  createMemberWorkSyncStatusToken,
  createMemberWorkSyncStatusVersion,
  readMemberWorkSyncStatusToken,
} from './memberWorkSyncStatusVersion.js';

import type {
  MemberWorkSyncReportReceipt,
  MemberWorkSyncReportReceiptDraft,
  MemberWorkSyncStatus,
} from '../policy/contracts/index.js';
import type {
  MemberWorkSyncAuthorityCommitResult,
  MemberWorkSyncAuthorityFailureReason as FailureReason,
  MemberWorkSyncAuthorityReadResult,
  MemberWorkSyncStatusAuthoritySnapshot,
} from '../policy/core/application/MemberWorkSyncConditionalStatusPort.js';
import type { MemberWorkSyncStatusBinding } from './memberWorkSyncStatusVersion.js';
import type { MemberWorkSyncTokenIdentity } from './reportTokenPorts.js';

export interface MemberWorkSyncPhysicalCall<T> {
  result: Promise<T>;
  /** Always resolves after all owned physical work and fence cleanup, including failure. */
  settled: Promise<void>;
}

export type MemberWorkSyncAuthorityRawSnapshot =
  | { state: 'absent'; raw: null }
  | { state: 'present'; raw: string; payload: unknown }
  | { state: 'corrupt' }
  | { state: 'unavailable' };

export type MemberWorkSyncAuthorityRawCommit =
  | { committed: true; snapshot: MemberWorkSyncAuthorityRawSnapshot; projectionDegraded?: string[] }
  | { committed: false; reason: 'conflict'; current: MemberWorkSyncAuthorityRawSnapshot }
  | { committed: false; reason: 'corrupt' | 'unavailable' | 'write_failed' }
  | { committed: 'unknown'; reason: 'commit_unknown'; mutationId: string };

/** Access is valid only inside the prepared backend callback and its held locks. */
export interface MemberWorkSyncPreparedStatusBackend {
  kind: 'json' | 'sqlite';
  read(memberName: string): Promise<MemberWorkSyncAuthorityRawSnapshot>;
  compareAndWrite(input: {
    expectedRaw: string | null;
    mutationId: string;
    nextStatus: MemberWorkSyncStatus;
    reportReceipt?: MemberWorkSyncReportReceiptDraft;
    replacedReceipt?: MemberWorkSyncReportReceipt;
  }): Promise<MemberWorkSyncAuthorityRawCommit>;
}

export type {
  MemberWorkSyncAuthorityCommitResult,
  MemberWorkSyncAuthorityReadResult,
  MemberWorkSyncStatusAuthoritySnapshot,
} from '../policy/core/application/MemberWorkSyncConditionalStatusPort.js';

export interface MemberWorkSyncStatusAuthorityDeps {
  identity: MemberWorkSyncTokenIdentity;
  /** Consumer-owned local/RPC interruption metadata; never serialized or inferred from an error string. */
  interruption?(
    error: unknown
  ): { execution: 'unknown' | 'not_started'; settled: Promise<void> } | undefined;
  /** Includes preflight, import and replica publication; never swallows interruption metadata. */
  withPreparedBackend<T>(
    identity: {
      teamName: string;
      incarnation: string;
      mutation: boolean;
      assertCurrent?: () => void;
    },
    operation: (backend: MemberWorkSyncPreparedStatusBackend) => Promise<T>
  ): Promise<T>;
}

interface MemberInput {
  teamName: string;
  memberName: string;
}
interface CommitInput extends MemberInput {
  incarnation: string;
  expectedToken: string;
  mutationId: string;
  nextStatus: MemberWorkSyncStatus;
  reportReceipt?: MemberWorkSyncReportReceiptDraft;
  replacedReceipt?: MemberWorkSyncReportReceipt;
}
type Outcome = MemberWorkSyncAuthorityReadResult | MemberWorkSyncAuthorityCommitResult;

function failureReason(error: unknown): FailureReason {
  return error instanceof MemberWorkSyncStatusDecodeError ||
    error instanceof MemberWorkSyncReportReceiptError ||
    error instanceof MemberWorkSyncStatusConflictError ||
    (error instanceof MemberWorkSyncSafetyJsonReadError && error.reason === 'corrupt')
    ? 'corrupt'
    : 'unavailable';
}

/** Canonical status authority. The consuming owner registers settled in its already-admitted gate/collector. */
export class MemberWorkSyncStatusAuthority {
  constructor(private readonly deps: MemberWorkSyncStatusAuthorityDeps) {}

  startRead(input: MemberInput): MemberWorkSyncPhysicalCall<MemberWorkSyncAuthorityReadResult> {
    return this.start(
      input,
      undefined
    ) as MemberWorkSyncPhysicalCall<MemberWorkSyncAuthorityReadResult>;
  }

  startCompareAndWrite(
    input: CommitInput
  ): MemberWorkSyncPhysicalCall<MemberWorkSyncAuthorityCommitResult> {
    return this.start(
      input,
      input
    ) as MemberWorkSyncPhysicalCall<MemberWorkSyncAuthorityCommitResult>;
  }

  private snapshot(
    raw: MemberWorkSyncAuthorityRawSnapshot,
    binding: MemberWorkSyncStatusBinding
  ): MemberWorkSyncStatusAuthoritySnapshot {
    if (raw.state === 'corrupt' || raw.state === 'unavailable')
      throw new MemberWorkSyncSafetyJsonReadError(raw.state);
    return {
      status:
        raw.state === 'absent' ? null : decodeMemberWorkSyncStoredStatus(raw.payload, binding),
      token: createMemberWorkSyncStatusToken(binding, raw.raw),
      incarnation: binding.incarnation,
    };
  }

  private start(
    input: MemberInput,
    commit: CommitInput | undefined
  ): MemberWorkSyncPhysicalCall<Outcome> {
    let resolveResult!: (value: Outcome) => void;
    const result = new Promise<Outcome>((resolve) => {
      resolveResult = resolve;
    });
    let phase: 'preparation' | 'read' | 'cas' | 'projection' = 'preparation';
    let uncertainCommit:
      | Extract<MemberWorkSyncAuthorityCommitResult, { committed: 'unknown' }>
      | undefined;
    let acknowledgedWrite = false;
    let knownCommit: Extract<MemberWorkSyncAuthorityCommitResult, { committed: true }> | undefined;
    const failed = (reason: FailureReason): Outcome =>
      commit ? { committed: false, reason } : { ok: false, reason };
    const classify = (error: unknown): Outcome => {
      const interruption = this.deps.interruption?.(error);
      if (knownCommit)
        return {
          ...knownCommit,
          projectionDegraded: [
            ...new Set([...knownCommit.projectionDegraded, 'backend_or_lifecycle']),
          ],
        };
      if (uncertainCommit) return uncertainCommit;
      if (commit && acknowledgedWrite)
        return { committed: 'unknown', reason: 'commit_unknown', mutationId: commit.mutationId };
      if (commit && phase === 'cas' && interruption?.execution !== 'not_started') {
        return { committed: 'unknown', reason: 'commit_unknown', mutationId: commit.mutationId };
      }
      return failed(failureReason(error));
    };
    // Deferring effects gives composition a synchronous window to register this entire lifetime.
    const physical = Promise.resolve().then(async () => {
      if (commit && !commit.mutationId.trim()) return failed('invalid_token');
      let identity = await this.deps.identity.readCurrent(input.teamName);
      if (
        !commit &&
        identity.status === 'unidentified' &&
        identity.reason === 'missing_marker' &&
        this.deps.identity.adoptLegacy
      ) {
        identity = await this.deps.identity.adoptLegacy(input.teamName);
      }
      if (identity.status !== 'identified')
        return failed(
          identity.status === 'absent' || identity.status === 'deleting'
            ? 'inactive'
            : 'unavailable'
        );
      if (commit && identity.identityId !== commit.incarnation) return failed('inactive');
      const incarnation = identity.identityId;
      const operation = async (assertCurrent?: () => void) => {
        try {
          return await this.deps.withPreparedBackend(
            {
              teamName: input.teamName,
              incarnation,
              mutation: Boolean(commit),
              ...(assertCurrent ? { assertCurrent } : {}),
            },
            async (backend): Promise<Outcome> => {
              const binding = { ...input, incarnation, backend: backend.kind };
              const expected = commit
                ? readMemberWorkSyncStatusToken(commit.expectedToken, binding)
                : undefined;
              if (expected && !expected.ok) return failed('invalid_token');
              phase = 'read';
              const raw = await backend.read(input.memberName);
              const current = this.snapshot(raw, binding);
              if (!commit) return { ok: true, snapshot: current };
              if (!expected?.ok || raw.state === 'corrupt' || raw.state === 'unavailable')
                return failed('unavailable');
              if (raw.raw !== expected.raw)
                return { committed: false, reason: 'conflict', current };
              const nextStatus = createMemberWorkSyncStatusVersion(
                current.status,
                commit.nextStatus,
                binding,
                undefined,
                commit.reportReceipt,
                commit.replacedReceipt
              );
              phase = 'cas';
              const outcome = await backend.compareAndWrite({
                expectedRaw: expected.raw,
                nextStatus,
                mutationId: commit.mutationId,
              });
              phase = 'projection';
              if (outcome.committed === true) {
                acknowledgedWrite = true;
                if (outcome.snapshot.state !== 'present')
                  throw new MemberWorkSyncStatusDecodeError('invalid_status');
                knownCommit = {
                  committed: true,
                  snapshot: this.snapshot(outcome.snapshot, binding),
                  projectionDegraded: outcome.projectionDegraded ?? [],
                };
                phase = 'projection';
                return knownCommit;
              }
              if (outcome.committed === false && outcome.reason === 'conflict')
                return {
                  committed: false,
                  reason: 'conflict',
                  current: this.snapshot(outcome.current, binding),
                };
              if (outcome.committed === 'unknown') {
                uncertainCommit = outcome;
                resolveResult(outcome);
              }
              return outcome;
            }
          );
        } catch (error) {
          const outcome = classify(error);
          if ('committed' in outcome && outcome.committed === 'unknown') resolveResult(outcome);
          // Catch must remain INSIDE withCurrent so a rejected RPC cannot release its fence.
          const interruption = this.deps.interruption?.(error);
          if (interruption) {
            resolveResult(outcome);
            await interruption.settled;
          }
          return outcome;
        }
      };
      const fenced = this.deps.identity.withCurrentPublication
        ? await this.deps.identity.withCurrentPublication(input.teamName, incarnation, operation)
        : this.deps.identity.withCurrent
          ? await this.deps.identity.withCurrent(input.teamName, incarnation, operation)
          : undefined;
      if (!fenced) return failed('unavailable');
      return fenced.current
        ? fenced.value
        : failed(fenced.identity.status === 'unavailable' ? 'unavailable' : 'inactive');
    });
    const settled = physical
      .then(resolveResult, async (error: unknown) => {
        resolveResult(classify(error));
        const interruption = this.deps.interruption?.(error);
        if (interruption) await interruption.settled;
      })
      .then(
        () => undefined,
        () => undefined
      );
    return { result, settled };
  }
}
