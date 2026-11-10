import type { Event } from '@agent-teams/provider-session-contracts';
import type { JsonValue } from '../contracts.js';
import type { RuntimeActivityEvent } from './activityContracts.js';

const CODES = new Set([
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
]);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
/** Bounded JSON only. No SDK envelope, class instances, getters, cycles or lossy serialization. */
function json(
  value: unknown,
  budget = { nodes: 1024, bytes: 16 * 1024 },
  depth = 0,
  seen = new Set<unknown>()
): JsonValue {
  if (--budget.nodes < 0 || depth > 8) throw new Error('shape');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    budget.bytes -= Buffer.byteLength(value);
    if (budget.bytes < 0) throw new Error('bytes');
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('shape');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 1024) throw new Error('shape');
      return Array.from(value, (item) => json(item, budget, depth + 1, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('shape');
    const result: Record<string, JsonValue> = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      budget.bytes -= Buffer.byteLength(key);
      if (!descriptor || !('value' in descriptor) || budget.bytes < 0) throw new Error('shape');
      Object.defineProperty(result, key, {
        value: json(descriptor.value, budget, depth + 1, seen),
        enumerable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
const gap = (reason: 'unsupported' | 'oversized'): RuntimeActivityEvent['data'] => ({
  kind: 'gap',
  reason,
});
/** SPI discriminants are mapped explicitly; arbitrary extra provider fields never cross this boundary. */
export function normalizeActivity(event: Event): RuntimeActivityEvent['data'] {
  try {
    switch (event.kind) {
      case 'text':
        if (
          !id(event.messageRef) ||
          !Number.isSafeInteger(event.block) ||
          event.block < 0 ||
          typeof event.text !== 'string' ||
          !['snapshot', 'complete'].includes(event.phase)
        )
          return gap('unsupported');
        if (Buffer.byteLength(event.text) > 24 * 1024) return gap('oversized');
        return {
          kind: 'text',
          messageRef: event.messageRef,
          block: event.block,
          text: event.text,
          phase: event.phase,
        };
      case 'tool':
        if (!id(event.messageRef) || !id(event.toolRef) || !id(event.name))
          return gap('unsupported');
        return {
          kind: 'tool',
          messageRef: event.messageRef,
          toolRef: event.toolRef,
          name: event.name,
          input: json(event.input),
        };
      case 'tool-result':
        if (!id(event.toolRef) || typeof event.isError !== 'boolean') return gap('unsupported');
        return {
          kind: 'tool-result',
          toolRef: event.toolRef,
          content: json(event.content),
          isError: event.isError,
        };
      case 'usage': {
        const result: Record<string, JsonValue> = { kind: 'usage' };
        for (const key of ['inputTokens', 'outputTokens', 'cumulativeCostUsd'] as const) {
          if (event[key] !== undefined) {
            if (
              !number(event[key]) ||
              (key !== 'cumulativeCostUsd' && !Number.isSafeInteger(event[key]))
            )
              return gap('unsupported');
            result[key] = event[key];
          }
        }
        return result as RuntimeActivityEvent['data'];
      }
      case 'compaction':
        if (!id(event.sourceRef) || !['manual', 'automatic', 'unknown'].includes(event.reason))
          return gap('unsupported');
        return { kind: 'compaction', sourceRef: event.sourceRef, reason: event.reason };
      case 'result':
        if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(event.outcome))
          return gap('unsupported');
        return {
          kind: 'result',
          outcome: event.outcome,
          ...(event.code && CODES.has(event.code) ? { code: event.code } : {}),
        };
      case 'interaction': {
        if (!id(event.interactionRef)) return gap('unsupported');
        const request = event.request;
        if (request.kind === 'permission' && id(request.tool))
          return {
            kind: 'interaction',
            interactionRef: event.interactionRef,
            request: { kind: 'permission', tool: request.tool, input: json(request.input) },
          };
        if (request.kind === 'question')
          return {
            kind: 'interaction',
            interactionRef: event.interactionRef,
            request: { kind: 'question', questions: json(request.questions) },
          };
        return gap('unsupported');
      }
      case 'diagnostic':
        return CODES.has(event.code)
          ? { kind: 'diagnostic', code: event.code }
          : gap('unsupported');
      default:
        return gap('unsupported');
    }
  } catch {
    return gap('oversized');
  }
}
