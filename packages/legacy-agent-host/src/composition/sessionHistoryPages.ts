import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { deliveryFingerprint, runtimeDigest } from '../runtime/identity.js';
import { messageSegments } from '../team/pageOwnerSnapshot.js';
import { projectRuntimeActivity } from './runtimeActivityProjection.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeInput } from '../runtime/contracts.js';
import type { ActivityLog } from './readTeamActivity.js';
import type { SessionHistorySource, TeamSessionHistoryReadOptions } from './readTeamSessionHistory.js';

const positionSchema = z.object({
  source: z.number().int().min(0).max(255),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
function fail(): never { throw new RuntimeOwnerError('hold'); }
/** Same read authority and immutable revision on every page; restart expires old cursors. */
export function sessionHistoryCursor(
  key: string, authority: string, sessionId: string, stream: string, revision: string
) {
  const sign = (body: string) => createHmac('sha256', key)
    .update(JSON.stringify({ protocol: 'session-history-v1', authority, sessionId, stream, revision, body })).digest('hex');
  return {
    write(position: z.infer<typeof positionSchema>): string {
      const body = Buffer.from(JSON.stringify(positionSchema.parse(position))).toString('base64url');
      return body + '.' + sign(body);
    },
    read(raw: string): z.infer<typeof positionSchema> {
      const match = /^([A-Za-z0-9_-]{1,1024})\.([a-f0-9]{64})$/u.exec(raw);
      if (!match) throw new RuntimeOwnerError('invalid');
      if (!timingSafeEqual(Buffer.from(match[2]!, 'hex'), Buffer.from(sign(match[1]!), 'hex'))) fail();
      try {
        const bytes = Buffer.from(match[1]!, 'base64url');
        if (bytes.toString('base64url') !== match[1]) fail();
        return positionSchema.parse(JSON.parse(bytes.toString('utf8')));
      } catch { throw new RuntimeOwnerError('invalid'); }
    },
  };
}
function assertSource(options: TeamSessionHistoryReadOptions, source: SessionHistorySource) {
  options.assertCurrent();
  options.team.owner.withLaunchAuthority(options.principalId, 'read', () => undefined);
  const observed = options.runtime.readCapturedSession(source.source.binding);
  if (!observed.record && source.source.recordRequired) fail();
  return observed;
}
/** One original feed page. Projection trimming always leaves a continuation, never a silent tail loss. */
export function readSessionActivityPage(
  options: TeamSessionHistoryReadOptions, source: SessionHistorySource, offset: number
): { value: { log: ActivityLog; messages: never[]; gaps: string[] }; nextOffset: number | null } {
  const observed = assertSource(options, source), binding = source.source.binding;
  const snapshot = options.runtime.readActivitySnapshot(binding);
  const start = offset === 0 ? Math.max(0, snapshot.retainedFrom - 1) : offset;
  if (start < snapshot.retainedFrom - 1 || start > snapshot.cursor.sequence) fail();
  const cursor = { ...snapshot.cursor, sequence: start };
  const feed = options.runtime.readActivityFeed(binding, cursor);
  const gaps = new Set<string>([...(snapshot.gap ? [snapshot.gap.reason] : []), ...(feed.gap ? [feed.gap.reason] : [])]);
  if (snapshot.retainedFrom > 1) gaps.add('Earlier runtime facts are no longer retained.');
  const inputById = new Map(observed.record?.inputs.map(input => [input.intent.inputId, input]) ?? []);
  const allowed = new Set<string>();
  for (const event of feed.events) {
    if (event.sequence > snapshot.cursor.sequence) break;
    if (event.inputId) {
      const input = inputById.get(event.inputId);
      if (!input || input.operationRef !== event.operationRef ||
          input.fingerprint !== deliveryFingerprint(input.intent) ||
          runtimeDigest(input.intent.binding) !== runtimeDigest(binding)) {
        gaps.add('An activity fact has no original input attribution.');
        continue;
      }
    }
    if (['text', 'thinking', 'process-output', 'tool', 'tool-result', 'usage', 'compaction',
      'result', 'diagnostic', 'gap', 'subagent'].includes(event.data.kind)) allowed.add(event.eventId);
  }
  const projected = projectRuntimeActivity({
    memberId: binding.memberId, source: feed, requested: cursor, nativeReady: source.nativeReady,
  }) as { events: ActivityLog['events'] };
  const consumed = projected.events.at(-1)?.sequence ?? start;
  if (consumed <= start && start < snapshot.cursor.sequence) fail();
  const events = projected.events.filter(event => allowed.has(event.eventId));
  const messages = new Set(events.filter(event => event.data.kind === 'text' || event.data.kind === 'thinking')
    .map(event => String(event.inputId) + ':' + String(event.data.messageRef)));
  const log: ActivityLog = {
    kind: 'host_activity', sessionId: 'host-activity-' + runtimeDigest(binding),
    memberId: binding.memberId, memberName: source.memberName, generation: binding.generation,
    description: 'Retained session activity', startTime: null, durationMs: null,
    messageCount: messages.size, isOngoing: observed.record ? observed.attached &&
      observed.record.inputs.some(input => ['claimed', 'consumed'].includes(input.phase)) : null,
    events, gaps: [...gaps],
  };
  return { value: { log, messages: [], gaps: [...gaps] },
    nextOffset: consumed < snapshot.cursor.sequence ? consumed : null };
}
export interface SessionConversationMessage {
  messageId: string;
  memberName: string;
  observedAt: string | null;
  /** Original persisted delivery state; only present on the Inputs stream. */
  phase?: RuntimeInput['phase'];
  text: string;
  part: number;
  parts: number;
}
/** Pages the original per-binding conversation, including text older than the activity ring. */
export function readSessionConversationPage(
  options: TeamSessionHistoryReadOptions, source: SessionHistorySource, offset: number
): { value: { log: null; messages: SessionConversationMessage[]; gaps: string[] }; nextOffset: number | null } {
  assertSource(options, source);
  const captured = options.runtime.readConversation(source.source.binding, 'messages', source.source.recordRequired);
  if (runtimeDigest(captured.binding) !== runtimeDigest(source.source.binding)) fail();
  const originals: JsonValue[] = (captured.messages ?? []).map(message => ({
    messageId: message.messageId, timestamp: message.observedAt, from: source.memberName, read: true,
    text: message.blocks.map(block => block.text).join('\n'),
  })).sort((a, b) => String((b as { timestamp: string }).timestamp)
    .localeCompare(String((a as { timestamp: string }).timestamp)));
  const segments = messageSegments(originals, 64 * 1024);
  if (offset > segments.length || offset === segments.length && offset !== 0) fail();
  const messages: SessionConversationMessage[] = [];
  let bytes = 0, end = offset;
  for (; end < segments.length && messages.length < 64; end++) {
    const segment = segments[end]!, value = segment.value as { messageId: string; timestamp: string; text: string };
    const projected = { messageId: value.messageId, memberName: source.memberName, observedAt: value.timestamp,
      text: value.text, part: segment.part.part, parts: segment.part.total };
    const size = Buffer.byteLength(JSON.stringify(projected));
    if (bytes + size > 192 * 1024) break;
    bytes += size;
    messages.push(projected);
  }
  if (end === offset && end < segments.length) fail();
  return { value: { log: null, messages, gaps: [...captured.gaps] },
    nextOffset: end < segments.length ? end : null };
}

/** Original admitted intent only: no native config, prepared context supplement or invented author/time. */
export function readSessionInputsPage(
  options: TeamSessionHistoryReadOptions, source: SessionHistorySource, offset: number
): { value: { log: null; messages: SessionConversationMessage[]; gaps: string[] }; nextOffset: number | null } {
  const { record } = assertSource(options, source), binding = source.source.binding;
  const inputs = record?.inputs ?? [];
  for (const input of inputs) {
    if (runtimeDigest(input.intent.binding) !== runtimeDigest(binding) ||
        input.fingerprint !== deliveryFingerprint(input.intent)) fail();
  }
  const originals: JsonValue[] = inputs.map(input => ({
    messageId: 'host-input-' + runtimeDigest({ binding, inputId: input.intent.inputId }),
    from: source.memberName, timestamp: '', read: true, text: input.intent.content,
  }));
  const segments = messageSegments(originals, 64 * 1024);
  if (offset > segments.length || offset === segments.length && offset !== 0) fail();
  const messages: SessionConversationMessage[] = [];
  let bytes = 0, end = offset;
  for (; end < segments.length && messages.length < 64; end++) {
    const segment = segments[end]!, value = segment.value as { messageId: string; text: string };
    const input = inputs[segment.part.index]!;
    const projected: SessionConversationMessage = { messageId: value.messageId, memberName: source.memberName,
      observedAt: null, phase: input.phase, text: value.text, part: segment.part.part, parts: segment.part.total };
    const size = Buffer.byteLength(JSON.stringify(projected));
    if (bytes + size > 192 * 1024) break;
    bytes += size; messages.push(projected);
  }
  if (end === offset && end < segments.length) fail();
  return { value: { log: null, messages, gaps: [] }, nextOffset: end < segments.length ? end : null };
}
