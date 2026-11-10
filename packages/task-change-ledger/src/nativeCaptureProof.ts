import type { EvidenceEvent } from './ledgerTypes.js';
import type { SnippetDiff } from './contracts.js';

function qualifiedOpenCodeUpdate(proof: Record<string, unknown>, cause: Record<string, unknown>, event: EvidenceEvent): boolean {
  const raw = cause.native;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const native = raw as Record<string, unknown>;
  const valid = (value: unknown, prefix = ''): value is string => typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length && value.length <= 1024 && !/[\0\r\n]/u.test(value);
  const tools = proof.tools;
  if (proof.kind !== 'opencode-update-patch-v1' || cause.toolName !== 'opencode.fileChange' || event.source !== 'file_edit' || event.operation !== 'modify' || event.beforeState?.exists !== true || event.afterState?.exists !== true || native.provider !== 'opencode' || !valid(proof.nativeSessionId, 'ses_') || !valid(proof.nativeInputId, 'msg_') || !valid(proof.windowRef) || native.nativeSessionId !== proof.nativeSessionId || native.nativeInputId !== proof.nativeInputId || native.windowRef !== proof.windowRef || !Array.isArray(tools) || !tools.length || tools.length > 32 || !Array.isArray(native.tools) || tools.length !== native.tools.length) return false;
  const calls = new Set<string>(), parts = new Set<string>();
  return tools.every((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const tool = value as Record<string, unknown>, peer = (native.tools as unknown[])[index];
    if (!peer || typeof peer !== 'object' || Array.isArray(peer)) return false;
    const anchor = peer as Record<string, unknown>;
    if (!valid(tool.messageId, 'msg_') || tool.messageId === proof.nativeInputId || !valid(tool.partId, 'prt_') || !valid(tool.callId) || calls.has(tool.callId) || parts.has(tool.partId) || anchor.messageId !== tool.messageId || anchor.partId !== tool.partId || anchor.callId !== tool.callId) return false;
    calls.add(tool.callId); parts.add(tool.partId);
    return index < tools.length - 1 || tool.callId === event.toolUseId;
  });
}

function qualifiedCodexUpdate(
  proof: Record<string, unknown>,
  cause: Record<string, unknown>,
  event: EvidenceEvent
): boolean {
  const native = cause.native;
  if (!native || typeof native !== 'object' || Array.isArray(native)) return false;
  const identity = native as Record<string, unknown>;
  const ids = proof.itemIds;
  const validId = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\0\r\n]/u.test(value);
  return (
    proof.kind === 'codex-update-patch-v1' &&
    cause.toolName === 'codex.fileChange' &&
    event.source === 'file_edit' &&
    event.operation === 'modify' &&
    event.beforeState?.exists === true &&
    event.afterState?.exists === true &&
    identity.provider === 'codex' &&
    [proof.threadId, proof.turnId, proof.windowRef].every(validId) &&
    identity.threadId === proof.threadId &&
    identity.turnId === proof.turnId &&
    identity.windowRef === proof.windowRef &&
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 32 &&
    ids.every(validId) &&
    new Set(ids).size === ids.length &&
    Array.isArray(identity.itemIds) &&
    identity.itemIds.length === ids.length &&
    identity.itemIds.every((id, index) => id === ids[index]) &&
    ids.at(-1) === event.toolUseId
  );
}
/** Old Host-native rows remain unqualified; legacy proof labels retain their behavior. */
export function nativeCaptureQualification(
  event: EvidenceEvent
): 'qualified' | 'unqualified' | undefined {
  if (
    event.causalBinding === undefined &&
    event.nativeCaptureProof === undefined &&
    !/^[a-f0-9]{64}$/u.test(event.evidenceProof ?? '')
  )
    return;
  const raw = event.nativeCaptureProof;
  const binding = event.causalBinding;
  if (!raw || typeof raw !== 'object' || !binding || typeof binding !== 'object')
    return 'unqualified';
  const proof = raw as Record<string, unknown>,
    cause = binding as Record<string, unknown>;
  const before = event.before?.sha256 ?? null;
  const kindMatches =
    (proof.kind === 'edit-input-v1' && cause.toolName === 'Edit' && event.source === 'file_edit') ||
    (proof.kind === 'write-input-v1' &&
      cause.toolName === 'Write' &&
      event.source === 'file_write') ||
    qualifiedCodexUpdate(proof, cause, event) ||
    qualifiedOpenCodeUpdate(proof, cause, event);
  return kindMatches &&
    cause.toolUseId === event.toolUseId &&
    event.toolStatus === 'succeeded' &&
    typeof proof.toolInputDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(proof.toolInputDigest) &&
    proof.beforeSha256 === before &&
    proof.afterSha256 === event.after?.sha256 &&
    typeof proof.afterSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(proof.afterSha256) &&
    (event.operation === 'create'
      ? before === null && event.beforeState?.exists === false
      : event.operation === 'modify' && before !== null)
    ? 'qualified'
    : 'unqualified';
}

/** Only native chains gain this stricter admission; legacy ledger behavior is unchanged. */
export function hasUnqualifiedNativeChain(snippets: readonly SnippetDiff[]): boolean {
  if (snippets.some((snippet) => snippet.ledger?.nativeCapture === 'unqualified')) return true;
  if (!snippets.some((snippet) => snippet.ledger?.nativeCapture === 'qualified')) return false;
  for (let index = 0; index < snippets.length; index++) {
    const current = snippets[index]!;
    if (current.isError || !current.ledger) return true;
    if (index > 0) {
      const previous = snippets[index - 1]!.ledger;
      if (!previous?.afterHash || previous.afterHash !== current.ledger.beforeHash) return true;
    }
  }
  return false;
}
