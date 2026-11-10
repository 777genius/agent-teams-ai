import { messageAttachmentReferencesSchema } from '../attachments/uploadContracts.js';
import { RuntimeOwnerError } from './contracts.js';
import { normalizeBinding, deliveryFingerprint } from './identity.js';
import type {
  RuntimeAdmission,
  RuntimeDelivery,
  RuntimeInput,
  RuntimeSessionRecord,
} from './contracts.js';

/** Canonical delivery identity and immutable original admission receipt; shared by owner paths. */
export function normalizeRuntimeDelivery(raw: RuntimeDelivery, maxBytes: number): RuntimeDelivery {
  if (raw.attachments !== undefined) messageAttachmentReferencesSchema.parse(raw.attachments);
  const intent = {
    binding: normalizeBinding(raw.binding),
    deliveryId: raw.deliveryId,
    inputId: raw.inputId,
    messageId: raw.messageId,
    content: raw.content,
    ...(raw.attachments?.length
      ? { attachments: messageAttachmentReferencesSchema.parse(raw.attachments) }
      : {}),
  };
  if (
    intent.inputId !== intent.deliveryId ||
    [intent.inputId, intent.messageId].some(
      (value) => typeof value !== 'string' || !value || value.length > 256
    ) ||
    typeof intent.content !== 'string' ||
    Buffer.byteLength(intent.content) > maxBytes
  )
    throw new RuntimeOwnerError('invalid');
  return intent;
}
export function findRuntimeInput(
  record: RuntimeSessionRecord,
  intent: RuntimeDelivery
): RuntimeInput | undefined {
  const input = record.inputs.find((item) => item.intent.inputId === intent.inputId);
  if (input && input.fingerprint !== deliveryFingerprint(intent))
    throw new RuntimeOwnerError('conflict');
  return input;
}
export function runtimeAdmission(input: RuntimeInput): RuntimeAdmission {
  return {
    inputId: input.intent.inputId,
    outcome: ['cancelled', 'rejected'].includes(input.phase) ? 'not_admitted' : 'admitted',
    receipt: {
      schemaVersion: 1,
      inputId: input.intent.inputId,
      binding: { ...input.intent.binding },
      fingerprint: input.fingerprint,
      operationRef: input.operationRef,
      phase: input.phase,
    },
  };
}
