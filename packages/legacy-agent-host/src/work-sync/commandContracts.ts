import { runtimeDigest } from '../runtime/identity.js';
import type { NativeMcpAuthorityProof } from '../team/NativeMcpAuthority.js';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import type { JsonValue } from '../contracts.js';
import type { TeamBinding } from '../team/contracts.js';

/** Private proof copied from the admitted original connection before any feature I/O. */
export interface NativeWorkSyncInputProof {
  team: NativeMcpAuthorityProof;
  /** Absent only on older status/report-only receipts; such rows cannot authorize deferred delivery. */
  runtime?: {
    profileId: string;
    hostIncarnation: string;
    configHash: string;
    openFingerprint: string;
  };
  original: {
    sessionRef: string;
    inputId: string;
    operationRef: string;
    fingerprint: string;
  };
}

/** Private original Team command family. Native tool payload never chooses actor or namespace. */
export interface WorkSyncCommandReceipt {
  schemaVersion: 1;
  family: 'work-sync';
  binding: TeamBinding;
  commandId: string;
  principalId: string;
  authorityRevision: number;
  inputAuthority: string;
  nativeInput: NativeWorkSyncInputProof;
  operation: 'status' | 'report';
  payload: JsonValue;
  fingerprint: string;
  receivedAt: string;
  mutationId: string;
  phase: 'prepared' | 'running' | 'held' | 'completed';
  result?: JsonValue;
}
export function workSyncCommandFingerprint(
  receipt: Pick<
    WorkSyncCommandReceipt,
    | 'binding'
    | 'commandId'
    | 'principalId'
    | 'authorityRevision'
    | 'inputAuthority'
    | 'nativeInput'
    | 'operation'
    | 'payload'
  >
) {
  return digest({
    family: 'work-sync',
    binding: receipt.binding,
    commandId: receipt.commandId,
    principalId: receipt.principalId,
    authorityRevision: receipt.authorityRevision,
    inputAuthority: receipt.inputAuthority,
    nativeInput: receipt.nativeInput,
    operation: receipt.operation,
    payload: receipt.payload,
  });
}
export function validateWorkSyncCommandReceipt(
  value: WorkSyncCommandReceipt
): WorkSyncCommandReceipt {
  if (
    value.schemaVersion !== 1 ||
    value.family !== 'work-sync' ||
    !value.binding ||
    typeof value.commandId !== 'string' ||
    !value.commandId ||
    value.commandId.length > 256 ||
    typeof value.principalId !== 'string' ||
    !value.principalId ||
    !Number.isSafeInteger(value.authorityRevision) ||
    value.authorityRevision < 1 ||
    !/^[a-f0-9]{64}$/.test(value.inputAuthority) ||
    !value.nativeInput?.team ||
    !value.nativeInput.original ||
    !value.nativeInput.team.source ||
    !value.nativeInput.team.original ||
    !value.nativeInput.team.cause ||
    !value.nativeInput.team.cause.binding ||
    value.nativeInput.team.mode !== 'do' ||
    value.nativeInput.team.principalId !== value.principalId ||
    value.nativeInput.team.authorityRevision !== value.authorityRevision ||
    value.nativeInput.team.source.backendId !== value.binding.backendId ||
    value.nativeInput.team.source.teamId !== value.binding.teamId ||
    value.nativeInput.team.original.inputId !== value.nativeInput.original.inputId ||
    (value.nativeInput.runtime !== undefined &&
      (typeof value.nativeInput.runtime.profileId !== 'string' ||
        !value.nativeInput.runtime.profileId ||
        typeof value.nativeInput.runtime.hostIncarnation !== 'string' ||
        !value.nativeInput.runtime.hostIncarnation ||
        !/^[a-f0-9]{64}$/.test(value.nativeInput.runtime.configHash) ||
        typeof value.nativeInput.runtime.openFingerprint !== 'string' ||
        !value.nativeInput.runtime.openFingerprint)) ||
    !value.nativeInput.original.sessionRef ||
    !value.nativeInput.original.operationRef ||
    !/^[a-f0-9]{64}$/.test(value.nativeInput.original.fingerprint) ||
    runtimeDigest({
      team: value.nativeInput.team.fingerprint,
      original: value.nativeInput.original,
    }) !== value.inputAuthority ||
    !['status', 'report'].includes(value.operation) ||
    !Object.hasOwn(value, 'payload') ||
    !['prepared', 'running', 'held', 'completed'].includes(value.phase) ||
    typeof value.receivedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.receivedAt)) ||
    typeof value.mutationId !== 'string' ||
    !value.mutationId ||
    value.fingerprint !== workSyncCommandFingerprint(value) ||
    (value.phase === 'completed') !== Object.hasOwn(value, 'result') ||
    Buffer.byteLength(JSON.stringify(value)) > 512 * 1024
  )
    throw new TeamOwnerError('hold');
  return value;
}
