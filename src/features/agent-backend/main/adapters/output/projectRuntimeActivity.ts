import type {
  BackendActivityData,
  BackendActivityEvent,
  BackendActivityFeed,
  BackendActivityGap,
  BackendActivitySnapshot,
  BackendActivityState,
  BackendActivityValue,
  BackendOperationRequest,
} from '../../../contracts/operations';

export function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid host projection');
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid host projection');
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid host projection');
  return value;
}
export function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error('Invalid host projection');
  return value as T;
}
export function array<T>(value: unknown, project: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid host projection');
  return value.map(project);
}

const activityGapReasons = [
  'retention',
  'incarnation',
  'cursor',
  'oversized',
  'unsupported',
  'unattributed',
  'storage',
  'state-unpublished',
] as const;
const activityCodes = [
  'invalid-config',
  'unavailable',
  'dependency-unavailable',
  'backpressure',
  'stale',
  'unsupported',
  'checkpoint-incompatible',
  'checkpoint-missing',
  'provider-failure',
  'output-limit',
  'unknown',
  'unknown-event',
  'iterator-ended',
] as const;
const runtimeDiagnostics = [
  'open-unknown',
  'observe-ended',
  'observe-failed',
  'readiness-unavailable',
  'close-unknown',
] as const;
function finite(value: unknown, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error('Invalid activity number');
  return value;
}
function activityText(value: unknown, max = 1024): string {
  const result = string(value);
  if (result.length > max || result.includes('\0')) throw new Error('Invalid activity text');
  return result;
}
function content(
  value: unknown,
  depth = 0,
  budget = { nodes: 1024, bytes: 16 * 1024 }
): BackendActivityValue {
  if (--budget.nodes < 0 || depth > 8) throw new Error('Invalid activity content');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    budget.bytes -= Buffer.byteLength(value);
    if (budget.bytes < 0) throw new Error('Invalid activity content');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => content(entry, depth + 1, budget));
  const source = row(value);
  return Object.fromEntries(
    Object.entries(source).map(([key, entry]) => {
      budget.bytes -= Buffer.byteLength(key);
      if (budget.bytes < 0) throw new Error('Invalid activity content');
      return [key, content(entry, depth + 1, budget)];
    })
  );
}
function activityState(value: unknown): BackendActivityState {
  const source = row(value);
  const control = source.control === null ? null : row(source.control);
  return {
    phase: oneOf(source.phase, ['unopened', 'opening', 'allocated', 'closing', 'closed', 'held']),
    custody: oneOf(source.custody, ['owned', 'released', 'unknown']),
    sealed: boolean(source.sealed),
    nativeReady: boolean(source.nativeReady),
    queuedInputs: finite(source.queuedInputs, true),
    activeInputs: finite(source.activeInputs, true),
    partial: boolean(source.partial),
    diagnostic: source.diagnostic === null ? null : oneOf(source.diagnostic, runtimeDiagnostics),
    control: control
      ? {
          inputId: activityText(control.inputId),
          phase: oneOf(control.phase, ['pending', 'unknown'] as const),
        }
      : null,
    interactions: array(source.interactions, (entry) => {
      const interaction = row(entry);
      return {
        interactionRef: activityText(interaction.interactionRef),
        inputId: activityText(interaction.inputId),
        kind: oneOf(interaction.kind, ['permission', 'question'] as const),
        expiresAt: finite(interaction.expiresAt),
        phase: oneOf(interaction.phase, ['pending', 'responding', 'resolved', 'unknown']),
      };
    }),
  };
}
function activityData(value: unknown, nested = false): BackendActivityData {
  const data = row(value);
  switch (data.kind) {
    case 'subagent': {
      if (nested) throw new Error('Nested subagent activity');
      const phase = oneOf(data.phase, [
        'started',
        'completed',
        'failed',
        'stopped',
        'fact',
        'interaction',
        'usage',
        'gap',
      ] as const);
      const alias = (value: unknown, prefix: string) => {
        const result = activityText(value);
        if (!new RegExp(`^${prefix}-[a-f0-9]{64}$`).test(result))
          throw new Error('Invalid subagent alias');
        return result;
      };
      const result: Extract<BackendActivityData, { kind: 'subagent' }> = {
        kind: 'subagent',
        phase,
        ...(data.childId === undefined && phase === 'gap'
          ? {}
          : { childId: alias(data.childId, 'child') }),
        ...(data.parentToolRef === undefined && phase === 'gap'
          ? {}
          : { parentToolRef: alias(data.parentToolRef, 'tool') }),
      };
      if (phase === 'fact' || phase === 'interaction') {
        const fact = activityData(data.fact, true);
        if (
          fact.kind === 'state' ||
          fact.kind === 'subagent' ||
          fact.kind === 'usage' ||
          fact.kind === 'result' ||
          fact.kind === 'process-output' ||
          (phase === 'interaction') !== (fact.kind === 'interaction')
        )
          throw new Error('Invalid subagent fact');
        result.fact = fact;
      }
      if (phase === 'usage')
        for (const key of ['childTotalTokens', 'childToolUses', 'childDurationMs'] as const)
          if (data[key] !== undefined) result[key] = finite(data[key], true);
      if (phase === 'gap')
        result.reason = oneOf(data.reason, ['unattributed', 'stale', 'conflict', 'limit'] as const);
      return result;
    }
    case 'text':
    case 'thinking':
      return {
        kind: data.kind,
        messageRef: activityText(data.messageRef),
        block: finite(data.block, true),
        text: activityText(data.text, 24 * 1024),
        phase: oneOf(data.phase, ['snapshot', 'complete'] as const),
      };
    case 'process-output': {
      if (nested) throw new Error('Nested process output');
      const text = activityText(data.text, 24 * 1024);
      if (Buffer.byteLength(text) > 24 * 1024) throw new Error('Oversized process output');
      return { kind: 'process-output', stream: oneOf(data.stream, ['stderr'] as const), text };
    }
    case 'tool':
      return {
        kind: 'tool',
        messageRef: activityText(data.messageRef),
        toolRef: activityText(data.toolRef),
        name: activityText(data.name),
        input: content(data.input),
      };
    case 'tool-result':
      return {
        kind: 'tool-result',
        toolRef: activityText(data.toolRef),
        content: content(data.content),
        isError: boolean(data.isError),
      };
    case 'usage': {
      const usage: Extract<BackendActivityData, { kind: 'usage' }> = { kind: 'usage' };
      for (const key of ['inputTokens', 'outputTokens', 'cumulativeCostUsd'] as const)
        if (data[key] !== undefined) usage[key] = finite(data[key], key !== 'cumulativeCostUsd');
      return usage;
    }
    case 'compaction':
      return {
        kind: 'compaction',
        sourceRef: activityText(data.sourceRef),
        reason: oneOf(data.reason, ['manual', 'automatic', 'unknown'] as const),
      };
    case 'result':
      return {
        kind: 'result',
        outcome: oneOf(data.outcome, ['succeeded', 'failed', 'cancelled', 'unknown'] as const),
        ...(data.code === undefined ? {} : { code: oneOf(data.code, activityCodes) }),
      };
    case 'interaction': {
      const request = row(data.request);
      const common = {
        kind: 'interaction' as const,
        interactionRef: activityText(data.interactionRef),
      };
      if (request.kind === 'permission')
        return {
          ...common,
          request: {
            kind: 'permission',
            tool: activityText(request.tool),
            input: content(request.input),
          },
        };
      if (request.kind === 'question')
        return { ...common, request: { kind: 'question', questions: content(request.questions) } };
      throw new Error('Invalid activity interaction');
    }
    case 'diagnostic':
      return { kind: 'diagnostic', code: oneOf(data.code, activityCodes) };
    case 'gap':
      return { kind: 'gap', reason: oneOf(data.reason, activityGapReasons) };
    case 'state':
      return { kind: 'state', state: activityState(data.state) };
    default:
      throw new Error('Invalid activity event');
  }
}
export function activityEvent(value: unknown): BackendActivityEvent {
  const source = row(value);
  const data = activityData(source.data);
  if (data.kind === 'process-output' && source.inputId !== undefined)
    throw new Error('Attributed process output');
  return {
    sequence: finite(source.sequence, true),
    eventId: activityText(source.eventId),
    ...(source.inputId === undefined ? {} : { inputId: activityText(source.inputId) }),
    data,
  };
}
export function activity(
  value: unknown,
  request: BackendOperationRequest
): BackendActivityFeed | BackendActivitySnapshot {
  const source = row(value);
  if (!('memberId' in request.payload) || source.memberId !== request.payload.memberId)
    throw new Error('Wrong activity member');
  const snapshot = request.operation === 'runtime.activity.snapshot';
  if (Buffer.byteLength(JSON.stringify(source)) > (snapshot ? 256 : 128) * 1024)
    throw new Error('Oversized activity result');
  const cursor = activityText(source.cursor);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid activity cursor');
  const result: BackendActivityFeed = {
    memberId: activityText(source.memberId, 256),
    cursor,
    retainedFrom: finite(source.retainedFrom, true),
    events: array(source.events, activityEvent),
    hasMore: boolean(source.hasMore),
    ...(source.gap === undefined
      ? {}
      : {
          gap: {
            reason: oneOf(row(source.gap).reason, activityGapReasons),
          } satisfies BackendActivityGap,
        }),
  };
  if (result.events.length > 64) throw new Error('Oversized activity page');
  if (!snapshot) return result;
  const latest = row(source.latest);
  return {
    ...result,
    state: source.state === null ? null : activityState(source.state),
    latest: {
      text: array(latest.text, activityEvent),
      tools: array(latest.tools, activityEvent),
      usage: array(latest.usage, activityEvent),
      interactions: array(latest.interactions, activityEvent),
      compaction: latest.compaction === null ? null : activityEvent(latest.compaction),
      ...(latest.subagents === undefined
        ? {}
        : { subagents: array(latest.subagents, activityEvent) }),
    },
  };
}
