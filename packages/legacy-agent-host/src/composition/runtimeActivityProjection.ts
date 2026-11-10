import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import type { JsonValue } from '../contracts.js';
import type {
  RuntimeActivityCursor,
  RuntimeActivityEvent,
  RuntimeActivityFeed,
  RuntimeActivitySnapshot,
  RuntimeActivityState,
} from '../runtime/activityContracts.js';

const id = z.string().min(1).max(256);
const decodedCursor = z
  .object({
    resource: z.string().regex(/^[a-f0-9]{64}$/),
    hostIncarnation: id,
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export function decodeActivityCursor(raw: string): RuntimeActivityCursor {
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw new Error('Invalid cursor');
    return decodedCursor.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new RuntimeOwnerError('invalid');
  }
}
const encodeActivityCursor = (cursor: RuntimeActivityCursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');
const pickActivity = (
  source: Record<string, JsonValue>,
  keys: readonly string[]
): Record<string, JsonValue> =>
  Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]!])
  );
function activityState(state: RuntimeActivityState): Record<string, JsonValue> {
  return {
    phase: state.phase,
    custody: state.custody,
    sealed: state.sealed,
    nativeReady: state.nativeReady,
    queuedInputs: state.queuedInputs,
    activeInputs: state.activeInputs,
    partial: state.partial,
    control: state.control ? { inputId: state.control.inputId, phase: state.control.phase } : null,
    diagnostic: state.diagnostic,
    interactions: state.interactions.map(({ interactionRef, inputId, kind, expiresAt, phase }) => ({
      interactionRef,
      inputId,
      kind,
      expiresAt,
      phase,
    })),
  };
}
function activityEvent(event: RuntimeActivityEvent): Record<string, JsonValue> {
  const data = event.data;
  const fields: Record<string, readonly string[]> = {
    text: ['kind', 'messageRef', 'block', 'text', 'phase'],
    tool: ['kind', 'messageRef', 'toolRef', 'name', 'input'],
    'tool-result': ['kind', 'toolRef', 'content', 'isError'],
    usage: ['kind', 'inputTokens', 'outputTokens', 'cumulativeCostUsd'],
    compaction: ['kind', 'sourceRef', 'reason'],
    result: ['kind', 'outcome', 'code'],
    diagnostic: ['kind', 'code'],
    gap: ['kind', 'reason'],
    subagent: ['kind', 'childId', 'parentToolRef', 'phase', 'fact', 'childTotalTokens', 'childToolUses', 'childDurationMs', 'reason'],
  };
  let projected: Record<string, JsonValue>;
  if (data.kind === 'state')
    projected = {
      kind: 'state',
      state: activityState(data.state as unknown as RuntimeActivityState),
    };
  else if (data.kind === 'interaction') {
    const request = data.request as Record<string, JsonValue>;
    projected = {
      kind: 'interaction',
      interactionRef: data.interactionRef!,
      request: pickActivity(
        request,
        request.kind === 'permission' ? ['kind', 'tool', 'input'] : ['kind', 'questions']
      ),
    };
  } else
    projected = fields[data.kind]
      ? pickActivity(data, fields[data.kind]!)
      : { kind: 'gap', reason: 'unsupported' };
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    ...(event.inputId === undefined ? {} : { inputId: event.inputId }),
    data: projected,
  };
}

/** Finite presentation only; ownership/readiness remains with the caller and Runtime. */
export function projectRuntimeActivity(options: {
  memberId: string;
  source: RuntimeActivityFeed | RuntimeActivitySnapshot;
  nativeReady: boolean;
  requested?: RuntimeActivityCursor;
}): JsonValue {
  const { source, requested } = options,
    cursor = { ...source.cursor };
  const result: Record<string, JsonValue> = {
    memberId: options.memberId,
    cursor: encodeActivityCursor(cursor),
    retainedFrom: source.retainedFrom,
    events: source.events.map(activityEvent),
    hasMore: source.hasMore,
    ...(source.gap ? { gap: { reason: source.gap.reason } } : {}),
  };
  const snapshot = 'latest' in source;
  if (snapshot) {
    result.state = source.state
      ? {
          ...activityState(source.state),
          nativeReady: source.state.nativeReady && options.nativeReady,
        }
      : null;
    result.latest = {
      text: source.latest.text.map(activityEvent),
      tools: source.latest.tools.map(activityEvent),
      usage: source.latest.usage.map(activityEvent),
      interactions: source.latest.interactions.map(activityEvent),
      subagents: source.latest.subagents.map(activityEvent),
      compaction: source.latest.compaction ? activityEvent(source.latest.compaction) : null,
    };
  }
  const budget = (snapshot ? 256 : 128) * 1024 - 1024;
  const size = () => Buffer.byteLength(JSON.stringify(result));
  while (size() > budget) {
    if (snapshot) {
      const latest = result.latest as Record<string, JsonValue>,
        groups = ['text', 'tools', 'usage', 'interactions', 'subagents'] as const;
      const oldest = groups
        .filter((key) => (latest[key] as JsonValue[]).length)
        .sort(
          (a, b) =>
            Number((latest[a] as Record<string, JsonValue>[])[0]!.sequence) -
            Number((latest[b] as Record<string, JsonValue>[])[0]!.sequence)
        )[0];
      if (!oldest) throw new RuntimeOwnerError('hold');
      (latest[oldest] as JsonValue[]).shift();
      result.gap = source.gap ? { reason: source.gap.reason } : { reason: 'retention' };
    } else {
      const events = result.events as Record<string, JsonValue>[];
      if (!events.length) throw new RuntimeOwnerError('hold');
      events.pop();
      result.hasMore = true;
      cursor.sequence = Number(events.at(-1)?.sequence ?? requested!.sequence);
      result.cursor = encodeActivityCursor(cursor);
    }
  }
  return result;
}
