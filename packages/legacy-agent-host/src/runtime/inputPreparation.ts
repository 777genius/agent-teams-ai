import { createHash } from 'node:crypto';
import { RuntimeOwnerError } from './contracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from './identity.js';
import type { RuntimeBinding, RuntimeInput, RuntimeSessionRecord } from './contracts.js';

/** Technical source identity only. Team owns the standing context and its representation. */
export interface RuntimeContextEpoch {
  epochId: string;
  sessionRef: string;
  sourceRef: string;
  inputId?: string;
  operationRef?: string;
}
export interface RuntimeInputPreparation {
  schemaVersion: 1;
  epochIds: string[];
  prefix: string;
  teamProof: string;
  bindingFingerprint: string;
  intentFingerprint: string;
  inputId: string;
  operationRef: string;
  prefixHash: string;
  /** UTF-8 content passed to the existing Session.submit: prepared prefix plus original content. */
  nativePayloadHash: string;
}
export type PreparedInputProof = Omit<RuntimeInputPreparation, 'prefix'>;
export interface InputPreparationRequest {
  sessionRef: string;
  inputId: string;
  operationRef: string;
  intentFingerprint: string;
  originalContentBytes: number;
  epochs: readonly RuntimeContextEpoch[];
  priorProofs: readonly PreparedInputProof[];
}
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/u.test(value);
const hold = (): never => {
  throw new RuntimeOwnerError('hold');
};
const textHash = (text: string) => createHash('sha256').update(text).digest('hex');

export function recordContextEpoch(
  record: RuntimeSessionRecord,
  event: {
    sessionRef: string;
    sourceRef: string;
    inputId?: string;
    operationRef?: string;
  }
): void {
  if (
    record.sessionRef !== event.sessionRef ||
    !id(event.sourceRef) ||
    (event.inputId === undefined) !== (event.operationRef === undefined)
  )
    hold();
  const epoch: RuntimeContextEpoch = {
    epochId: runtimeDigest({
      binding: normalizeBinding(record.binding),
      sessionRef: event.sessionRef,
      sourceRef: event.sourceRef,
    }),
    sessionRef: event.sessionRef,
    sourceRef: event.sourceRef,
    ...(event.inputId === undefined
      ? {}
      : { inputId: event.inputId, operationRef: event.operationRef! }),
  };
  const epochs = (record.contextEpochs ??= []);
  const existing = epochs.find((value) => value.epochId === epoch.epochId);
  if (existing) {
    if (runtimeDigest(existing) !== runtimeDigest(epoch)) hold();
    return;
  }
  if (epochs.length >= 128) hold();
  epochs.push(epoch);
}
export function preparedInputProof(value: RuntimeInputPreparation): PreparedInputProof {
  const { prefix: _prefix, ...proof } = value;
  return structuredClone(proof);
}
export function prepareRuntimeInput(
  binding: RuntimeBinding,
  input: RuntimeInput,
  selected: {
    epochIds: readonly string[];
    prefix: string;
    teamProof: string;
  },
  maxBytes: number
): RuntimeInputPreparation {
  if (
    !Array.isArray(selected.epochIds) ||
    !selected.epochIds.length ||
    selected.epochIds.length > 128 ||
    new Set(selected.epochIds).size !== selected.epochIds.length ||
    selected.epochIds.some((value) => !hash(value)) ||
    !hash(selected.teamProof) ||
    typeof selected.prefix !== 'string' ||
    !selected.prefix ||
    selected.prefix.includes('\0') ||
    Buffer.byteLength(selected.prefix + input.intent.content) > maxBytes
  )
    hold();
  return {
    schemaVersion: 1,
    epochIds: [...selected.epochIds],
    prefix: selected.prefix,
    teamProof: selected.teamProof,
    bindingFingerprint: runtimeDigest(normalizeBinding(binding)),
    intentFingerprint: deliveryFingerprint(input.intent),
    inputId: input.intent.inputId,
    operationRef: input.operationRef,
    prefixHash: textHash(selected.prefix),
    nativePayloadHash: textHash(selected.prefix + input.intent.content),
  };
}
export function validatePreparedInput(binding: RuntimeBinding, input: RuntimeInput): void {
  const value = input.preparation;
  if (!value) return;
  if (input.phase === 'admitted') hold();
  const expected = prepareRuntimeInput(binding, input, value, 256 * 1024);
  if (runtimeDigest(expected) !== runtimeDigest(value)) hold();
}
export function validateContextEpochs(record: RuntimeSessionRecord): void {
  const epochs = record.contextEpochs ?? [];
  if (!Array.isArray(epochs) || epochs.length > 128) hold();
  const seen = new Set<string>();
  for (const epoch of epochs) {
    if (
      !epoch ||
      !id(epoch.sessionRef) ||
      epoch.sessionRef !== record.sessionRef ||
      !id(epoch.sourceRef) ||
      seen.has(epoch.epochId) ||
      epoch.epochId !==
        runtimeDigest({
          binding: normalizeBinding(record.binding),
          sessionRef: epoch.sessionRef,
          sourceRef: epoch.sourceRef,
        }) ||
      (epoch.inputId === undefined) !== (epoch.operationRef === undefined) ||
      (epoch.inputId !== undefined &&
        (!id(epoch.inputId) ||
          !id(epoch.operationRef) ||
          !record.inputs.some(
            (input) =>
              input.intent.inputId === epoch.inputId && input.operationRef === epoch.operationRef
          )))
    )
      hold();
    seen.add(epoch.epochId);
  }
  for (const input of record.inputs) {
    validatePreparedInput(record.binding, input);
    // Team may represent a pending business reminder in a later captured generation.
    // The exact native preparation remains bound to THIS immutable input and binding.
  }
}
