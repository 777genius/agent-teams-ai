/**
 * Closed causal facts of a failed OpenCode state-changing bridge operation.
 * Facts are keyed by the thrown object itself, so the original exception stays
 * the thrown value and only finite, allowlisted facts ever leave this module.
 */

import type { OpenCodeStopHandshakeFailureFacts } from '@shared/types';

const causalSnapshots = new WeakSet<object>();
const causalFailures = new WeakMap<
  object,
  {
    phase: string;
    cleanupErrno?: string | null;
    handshakeFailure?: OpenCodeStopHandshakeFailureFacts;
  }
>();
export function rememberOpenCodeHandshakeFailure(
  error: Error,
  failure: OpenCodeStopHandshakeFailureFacts
): void {
  const lockCode = (['ELOCKED', 'ECOMPROMISED'] as const).find(
    (value) => value === failure.lockCode
  );
  const lockCategory = (['registry', 'profile', 'startup', 'unknown'] as const).find(
    (value) => value === failure.lockCategory
  );
  const messageShape = (['code', 'lock_operation', 'unclassified'] as const).find(
    (value) => value === failure.messageShape
  );
  // A family is a closed token, never message text, even behind a widening cast.
  const messageFamily =
    typeof failure.messageFamily === 'string' && /^[a-z_]{2,90}$/.test(failure.messageFamily)
      ? failure.messageFamily
      : undefined;
  const messageDigest =
    typeof failure.messageDigest === 'string' && /^[a-f0-9]{12}$/.test(failure.messageDigest)
      ? failure.messageDigest
      : undefined;
  causalFailures.set(error, {
    ...(causalFailures.get(error) ?? { phase: 'handshake' }),
    handshakeFailure: Object.freeze({
      kind: failure.kind,
      ...(failure.sdkCode ? { sdkCode: failure.sdkCode } : {}),
      ...(failure.nativeOperation ? { nativeOperation: failure.nativeOperation } : {}),
      ...(Number.isInteger(failure.nativeErrno) &&
      (failure.nativeErrno ?? -1) >= 0 &&
      (failure.nativeErrno ?? -1) <= 0xffffffff
        ? { nativeErrno: failure.nativeErrno }
        : {}),
      ...(lockCode ? { lockCode } : {}),
      ...(lockCategory ? { lockCategory } : {}),
      ...(messageShape ? { messageShape } : {}),
      ...(messageFamily ? { messageFamily } : {}),
      ...(messageDigest ? { messageDigest } : {}),
    }),
  });
}
/** Identity-only delivery observation: never inspect an unowned thrown value. */
export function ownedOpenCodeHandshakeFailure(error: unknown) {
  const facts = error && typeof error === 'object' ? causalFailures.get(error) : undefined;
  if (!facts?.handshakeFailure) return undefined;
  const snapshot = Object.freeze({ ...facts, reason: null, errno: null, sourceFrame: null });
  causalSnapshots.add(snapshot);
  return snapshot;
}
/** The first phase that saw a thrown object wins; later rethrows keep it. */
export function rememberOpenCodeStateChangingFailurePhase(error: unknown, phase: string): void {
  if (error && typeof error === 'object' && !causalFailures.has(error))
    causalFailures.set(error, { phase });
}

/** Identity-owned phases before dispatch; ledger/recovery errors remain uncertain. */
export function didOpenCodeCommandFailBeforeDispatch(error: unknown): boolean {
  const facts = error && typeof error === 'object' ? causalFailures.get(error) : undefined;
  return (
    facts != null &&
    ['binding', 'handshake', 'handshake_validation', 'lease_acquire'].includes(facts.phase)
  );
}
/** A failed cleanup only adds its closed errno to the primary failure's facts. */
export function rememberOpenCodeStateChangingCleanupFailure(
  primary: unknown,
  cleanup: unknown
): void {
  const facts = primary && typeof primary === 'object' ? causalFailures.get(primary) : undefined;
  if (facts) facts.cleanupErrno = projectOpenCodeStateChangingFailure(cleanup).errno;
}
/** Closed causal facts only; the original exception remains the thrown object. */
export function projectOpenCodeStateChangingFailure(error: unknown) {
  const object = error && typeof error === 'object' ? error : {};
  const code = 'code' in object ? object.code : null;
  const errno =
    [
      'EACCES',
      'EPERM',
      'ENOENT',
      'ENOSPC',
      'EIO',
      'EROFS',
      'EEXIST',
      'ENOTDIR',
      'EISDIR',
      'EMFILE',
      'ENFILE',
      'EBUSY',
      'EINVAL',
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ABORT_ERR',
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    ].find((value) => value === code) ?? null;
  const message = error instanceof Error ? error.message : '';
  const reason =
    [
      'OpenCode lifecycle command requires the exact persisted lane run and capability snapshot',
      'OpenCode lifecycle command requires a persisted lane capability snapshot',
      'OpenCode lifecycle capability snapshot does not match the persisted lane manifest',
      'Bridge handshake client identity mismatch',
      'Bridge server capability snapshot mismatch',
      'Bridge server active run mismatch',
      'Bridge server runtime manifest high watermark is stale',
      'Bridge handshake identity hash mismatch',
      'OpenCode lifecycle command body does not match its persisted lane identity',
      'Invalid OpenCode Stop domain result; exact-target reconciliation required',
      'Invalid durable Stop result; reconciliation required',
      'Stop binding mismatch; reconciliation required',
      'Stop receipt target/runtime mismatch; reconciliation required',
      'Invalid original Stop identity; reconciliation unknown',
      'Stop reconciliation unknown: original session set missing',
      'Ambiguous original Stop session set',
      'Invalid original Stop capability/behavior identity',
      'Bridge handshake protocol version mismatch',
      'Unsupported Stop recovery capability/version; reconciliation unknown',
      'Stop target changed before dispatch; reconciliation required',
      'OpenCode bridge command outcome must be reconciled before retry',
      'OpenCode bridge command already started',
      'OpenCode bridge command completed concurrently; retry recovery',
      'OpenCode bridge command already completed; recover through commandStatus',
      'Invalid Stop recovery object; reconciliation required',
      'Unsupported Stop recovery contract version',
      'Stop observation session-set token mismatch',
      'Stop recovery requires a validated success envelope',
      'OpenCode Stop requires authoritative exact-target reconciliation; no durable outcome',
      'OpenCode Stop recovery target or outcome mismatch; reconciliation required',
      'Stop receipt envelope identity mismatch; reconciliation required',
      'OpenCode bridge idempotency key reused with different payload',
      'OpenCode bridge command lease was not created',
    ].find((value) => value === message) ?? null;
  const frame =
    error instanceof Error
      ? /(?:^|[/\\])((?:OpenCodeStateChangingBridgeCommandService|OpenCodeBridgeCommandClient|OpenCodeBridgeHandshakeClient|OpenCodeBridgeCommandLedgerStore|OpenCodeLifecycleManifestBinding|OpenCodeRuntimeStopProtocol|OpenCodeStopOutcomeRecovery)\.ts):(\d{1,7}):(\d{1,5})(?:\)|$)/m.exec(
          error.stack ?? ''
        )
      : null;
  const snapshot = {
    ...(causalFailures.get(object) ?? { phase: 'unclassified' }),
    reason,
    errno,
    sourceFrame: frame
      ? Object.freeze({ source: frame[1], line: Number(frame[2]), column: Number(frame[3]) })
      : null,
  };
  Object.freeze(snapshot);
  causalSnapshots.add(snapshot);
  return snapshot;
}
export function ownedOpenCodeStateChangingFailure(value: unknown) {
  return value && typeof value === 'object' && causalSnapshots.has(value)
    ? (value as ReturnType<typeof projectOpenCodeStateChangingFailure>)
    : undefined;
}

export function formatOpenCodeStopCausalSuffix(value: unknown): string {
  const snapshot = ownedOpenCodeStateChangingFailure(value);
  if (!snapshot) return '';
  const json = JSON.stringify(snapshot);
  return json.length <= 2048 ? '\nOPENCODE_STOP_CAUSE_V1=' + json : '';
}
