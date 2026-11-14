import { runtimeDigest } from '../runtime/identity.js';

import type { JsonValue } from '../contracts.js';
import type { RuntimeSessionRecord } from '../runtime/contracts.js';
import type { MemberEntry } from './MemberEntry.js';

export interface CapturedPromptOperationProof {
  readonly inputId: string;
  readonly operationRef: string;
}

/**
 * A read-only, feature-owned Boolean proof. Keep private Runtime operation
 * references and native session custody out of the ordinary public snapshot.
 * Only the existing authorized runtime.read route can request this check.
 */
export function checkCapturedPromptOperation(input: {
  readonly entry: MemberEntry;
  readonly record: RuntimeSessionRecord | undefined;
  readonly projection: JsonValue;
  readonly hostIncarnation: string;
  readonly proof: CapturedPromptOperationProof;
}): boolean {
  const { entry, record, projection, hostIncarnation, proof } = input;
  if (!record || !projection || typeof projection !== 'object' ||
      Array.isArray(projection) ||
      (entry.profile.provider !== 'claude' && entry.profile.provider !== 'codex') ||
      projection.memberId !== entry.binding.memberId ||
      projection.generation !== entry.binding.generation ||
      projection.nativeReady !== true || projection.attached !== true ||
      projection.phase !== 'allocated' || projection.sealed !== false ||
      projection.custody !== 'owned' ||
      record.hostIncarnation !== hostIncarnation ||
      record.sessionRef !== entry.profile.sessionId ||
      record.phase !== 'allocated' || record.sealed || !record.nativeReady ||
      record.custody !== 'owned' ||
      runtimeDigest(record.binding) !== runtimeDigest(entry.binding) ||
      record.inputs.length > 2048) return false;
  const matches = record.inputs.flatMap((row, index) =>
    row.intent.inputId === proof.inputId && row.operationRef === proof.operationRef
      ? [index] : []);
  if (matches.length !== 1) return false;
  const index = matches[0]!;
  const original = record.inputs[index]!;
  if (original.phase !== 'terminal' || original.terminal !== 'succeeded' ||
      runtimeDigest(original.intent.binding) !== runtimeDigest(entry.binding) ||
      !entry.team.owner.isOriginalHumanDirectDelivery(original.intent)) return false;
  return record.inputs.slice(index + 1).every((row) =>
    row.phase === 'admitted' || row.phase === 'cancelled' ||
    row.phase === 'rejected' || row.phase === 'not-sent');
}
