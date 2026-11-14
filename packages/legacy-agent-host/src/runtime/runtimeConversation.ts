import { RuntimeOwnerError } from './contracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from './identity.js';
import { CONVERSATION_GAPS, CONVERSATION_LIMITS } from './activityContracts.js';
import type { RuntimeBinding, RuntimeSessionRecord } from './contracts.js';
import type { RuntimeActivityEvent, RuntimeConversationGap, RuntimeConversationMarker,
  RuntimeConversationMessage, RuntimeConversationRecord, RuntimeEventStorage } from './activityContracts.js';
import type { Event } from '@agent-teams/provider-session-contracts';

function fail(): never { throw new RuntimeOwnerError('hold'); }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2));
// A later finite loss marker must still fit without evicting the previous valid reply.
const reservedBytes = (value: RuntimeConversationRecord) => bytes({ ...value,
  sequence: Number.MAX_SAFE_INTEGER, gaps: [...CONVERSATION_GAPS] });
const id = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value);
const sequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const dated = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
export function conversationGaps(values: readonly RuntimeConversationGap[]): RuntimeConversationGap[] {
  return CONVERSATION_GAPS.filter(value => values.includes(value));
}
/** Closed paired text only; the original diagnostic normalizer and its limits stay unchanged. */
export function normalizeConversationText(event: Extract<Event, { kind: 'text' }>): RuntimeActivityEvent['data'] {
  try {
    const [messageRef, block, text, phase] = ['messageRef', 'block', 'text', 'phase'].map(key => {
      const field = Object.getOwnPropertyDescriptor(event, key);
      if (!field || !('value' in field)) throw new Error('shape');
      return field.value as unknown;
    });
    if (!id(messageRef, 1024) || !sequence(block) || typeof text !== 'string' ||
        (phase !== 'snapshot' && phase !== 'complete')) return { kind: 'gap', reason: 'unsupported' };
    if (messageRef.startsWith('local-command:')) return { kind: 'text', messageRef, block, phase, text: '' };
    if (Buffer.byteLength(text) > CONVERSATION_LIMITS.bytes) return { kind: 'gap', reason: 'oversized' };
    return { kind: 'text', messageRef, block, phase, text };
  } catch { return { kind: 'gap', reason: 'unsupported' }; }
}
function validGaps(values: unknown): values is RuntimeConversationGap[] {
  return Array.isArray(values) && values.length <= CONVERSATION_GAPS.length &&
    values.every(value => CONVERSATION_GAPS.includes(value)) &&
    runtimeDigest(values) === runtimeDigest(conversationGaps(values));
}
function seal(body: Omit<RuntimeConversationRecord, 'digest'>): RuntimeConversationRecord {
  return { ...body, digest: runtimeDigest(body) };
}
export function emptyConversation(binding: RuntimeBinding): RuntimeConversationRecord {
  return seal({ schemaVersion: 1, binding: normalizeBinding(binding), sequence: 0, gaps: [], messages: [] });
}
export function conversationMarker(record: RuntimeConversationRecord): RuntimeConversationMarker {
  return { sequence: record.sequence, digest: record.digest, gaps: [...record.gaps] };
}
export function validateConversationMarker(record: RuntimeSessionRecord): void {
  const marker = record.conversation;
  if (marker === undefined) return;
  if (!marker || !sequence(marker.sequence) || marker.sequence > (record.activitySequence ?? 0) ||
      typeof marker.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(marker.digest) || !validGaps(marker.gaps)) fail();
  if (marker.sequence === 0 &&
      runtimeDigest(marker) !== runtimeDigest(conversationMarker(emptyConversation(record.binding)))) fail();
}
function messageIdentity(binding: RuntimeBinding, inputId: string, operationRef: string, messageRef: string): string {
  return 'host-reply-' + runtimeDigest({ binding: normalizeBinding(binding), inputId, operationRef, messageRef });
}
/** Validate derived bytes separately; the original mixed activity record is never enlarged. */
export function validateConversation(record: RuntimeConversationRecord): void {
  if (!record || record.schemaVersion !== 1 || !sequence(record.sequence) ||
      !validGaps(record.gaps) || !Array.isArray(record.messages) ||
      record.messages.length > CONVERSATION_LIMITS.messages || bytes(record) > CONVERSATION_LIMITS.bytes ||
      reservedBytes(record) > CONVERSATION_LIMITS.bytes) fail();
  const binding = normalizeBinding(record.binding);
  if (runtimeDigest(binding) !== runtimeDigest(record.binding)) fail();
  const { digest, ...body } = record;
  if (typeof digest !== 'string' || runtimeDigest(body) !== digest) fail();
  const seen = new Set<string>();
  let previous = 0;
  for (const message of record.messages) {
    if (!message || !id(message.inputId, 256) || !id(message.operationRef, 256) ||
        !id(message.messageRef, 1024) || message.messageRef.startsWith('local-command:') ||
        message.messageId !== messageIdentity(binding, message.inputId, message.operationRef, message.messageRef) ||
        seen.has(message.messageId) || !sequence(message.firstSequence) ||
        message.firstSequence <= previous || message.firstSequence > record.sequence || !dated(message.observedAt) ||
        !Array.isArray(message.blocks) || !message.blocks.length) fail();
    seen.add(message.messageId); previous = message.firstSequence;
    let block = -1;
    for (const part of message.blocks) {
      if (!part || !sequence(part.block) || part.block <= block || !sequence(part.sequence) ||
          part.sequence < message.firstSequence || part.sequence > record.sequence ||
          typeof part.text !== 'string' || Buffer.byteLength(part.text) > CONVERSATION_LIMITS.bytes ||
          !['snapshot', 'complete'].includes(part.phase)) fail();
      block = part.block;
    }
  }
  if (record.sequence === 0 && (record.messages.length || record.gaps.length ||
      record.digest !== emptyConversation(binding).digest)) fail();
}
function assertInput(record: RuntimeSessionRecord, inputId: string, operationRef: string): void {
  const input = record.inputs.find(value => value.intent.inputId === inputId);
  if (!input || input.operationRef !== operationRef || input.fingerprint !== deliveryFingerprint(input.intent) ||
      runtimeDigest(normalizeBinding(input.intent.binding)) !== runtimeDigest(normalizeBinding(record.binding)) ||
      !['claimed', 'consumed', 'terminal', 'unknown'].includes(input.phase)) fail();
}
export function validateConversationInputs(record: RuntimeSessionRecord, value: RuntimeConversationRecord): void {
  if (runtimeDigest(value.binding) !== runtimeDigest(normalizeBinding(record.binding))) fail();
  for (const row of value.messages) assertInput(record, row.inputId, row.operationRef);
}
/** The caller has already selected only accepted text or its explicit loss marker. */
export function updateConversation(
  runtime: RuntimeSessionRecord,
  previous: RuntimeConversationRecord,
  events: readonly RuntimeActivityEvent[],
  initialGaps: readonly RuntimeConversationGap[] = []
): RuntimeConversationRecord {
  const next = structuredClone(previous);
  const gaps = new Set<RuntimeConversationGap>([...next.gaps, ...initialGaps]);
  let changed = gaps.size !== next.gaps.length;
  for (const event of events) {
    const data = event.data;
    if (data.kind === 'gap') {
      const reason = CONVERSATION_GAPS.includes(data.reason as RuntimeConversationGap)
        ? data.reason as RuntimeConversationGap : 'unsupported';
      if (!gaps.has(reason)) { gaps.add(reason); changed = true; next.sequence = Math.max(next.sequence, event.sequence); }
      continue;
    }
    if (data.kind !== 'text' || typeof data.messageRef !== 'string' || data.messageRef.startsWith('local-command:')) continue;
    if (!event.inputId || !event.operationRef) fail();
    assertInput(runtime, event.inputId, event.operationRef);
    if (!dated(event.observedAt)) {
      if (!gaps.has('undated')) { gaps.add('undated'); changed = true; next.sequence = Math.max(next.sequence, event.sequence); }
      continue;
    }
    if (!sequence(data.block) || typeof data.text !== 'string' ||
        Buffer.byteLength(data.text) > CONVERSATION_LIMITS.bytes || (data.phase !== 'snapshot' && data.phase !== 'complete')) fail();
    const messageId = messageIdentity(runtime.binding, event.inputId, event.operationRef, data.messageRef);
    const old = next.messages.find(row => row.messageId === messageId);
    if (!old && !data.text.trim()) continue;
    const oldBlock = old?.blocks.find(row => row.block === data.block);
    if (oldBlock?.phase === 'complete' && data.phase === 'snapshot') continue;
    if (oldBlock && oldBlock.text === data.text && oldBlock.phase === data.phase) continue;
    const message: RuntimeConversationMessage = old ? structuredClone(old) : {
      messageId, inputId: event.inputId, operationRef: event.operationRef, messageRef: data.messageRef,
      firstSequence: event.sequence, observedAt: event.observedAt, blocks: [],
    };
    const part = { block: data.block, sequence: event.sequence, text: data.text, phase: data.phase as 'snapshot' | 'complete' };
    const at = message.blocks.findIndex(row => row.block === part.block);
    if (at < 0) message.blocks.push(part); else message.blocks[at] = part;
    message.blocks.sort((a, b) => a.block - b.block);
    if (reservedBytes({ ...next, messages: [message] }) > CONVERSATION_LIMITS.bytes) {
      if (!gaps.has('oversized')) { gaps.add('oversized'); changed = true; next.sequence = Math.max(next.sequence, event.sequence); }
      continue;
    }
    if (old) next.messages[next.messages.indexOf(old)] = message; else next.messages.push(message);
    next.sequence = Math.max(next.sequence, event.sequence); changed = true;
  }
  if (!changed) return previous;
  next.gaps = conversationGaps([...gaps]);
  next.messages.sort((a, b) => a.firstSequence - b.firstSequence);
  if (next.sequence === 0) next.sequence = runtime.activitySequence ?? 0;
  const finalize = () => {
    const { digest, ...body } = next; void digest;
    next.digest = runtimeDigest(body);
  };
  finalize();
  while (next.messages.length > CONVERSATION_LIMITS.messages || reservedBytes(next) > CONVERSATION_LIMITS.bytes) {
    if (!next.messages.length) fail();
    next.messages.shift();
    next.gaps = conversationGaps([...next.gaps, 'retention']); finalize();
  }
  validateConversation(next);
  return next;
}
/** Old records are projected from their dated retained events only; reading never migrates them. */
export function legacyConversation(
  record: RuntimeSessionRecord,
  events: readonly RuntimeActivityEvent[]
): RuntimeConversationRecord {
  const text = events.filter(event => event.data.kind === 'text' &&
    !(typeof event.data.messageRef === 'string' && event.data.messageRef.startsWith('local-command:')));
  if (!record.inputs.length && !text.length) return emptyConversation(record.binding);
  if (!text.length && !record.activitySequence) return emptyConversation(record.binding);
  return updateConversation(record, emptyConversation(record.binding), text, ['legacy-history']);
}
/** Bound derived history must agree with the original state hint, including after interrupted publication. */
export function readBoundConversation(
  storage: RuntimeEventStorage, record: RuntimeSessionRecord
): RuntimeConversationRecord {
  if (!storage.readConversation || !storage.writeConversation || !record.conversation) fail();
  validateConversationMarker(record);
  const stored = storage.readConversation(record.binding);
  const value = stored ?? (record.conversation.sequence === 0 ? emptyConversation(record.binding) : fail());
  validateConversation(value); validateConversationInputs(record, value);
  if (runtimeDigest(conversationMarker(value)) !== runtimeDigest(record.conversation)) fail();
  return value;
}
/** The marker deliberately cannot match a previously valid file after lost derived publication. */
export function failedConversationMarker(record: RuntimeSessionRecord): RuntimeConversationMarker {
  return { sequence: record.activitySequence ?? 1,
    digest: runtimeDigest({ binding: normalizeBinding(record.binding), sequence: record.activitySequence,
      unpublished: true, previous: record.conversation?.digest ?? null }),
    gaps: conversationGaps([...(record.conversation?.gaps ?? []), 'storage']) };
}
