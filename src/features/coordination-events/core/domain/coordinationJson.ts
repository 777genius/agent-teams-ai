import {
  MAX_COORDINATION_EVENT_PAYLOAD_DEPTH,
  MAX_COORDINATION_EVENT_PAYLOAD_NODES,
  MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES,
  MAX_COORDINATION_SNAPSHOT_DEPTH,
  MAX_COORDINATION_SNAPSHOT_NODES,
  SnapshotEventHandoffError,
} from './snapshotEventLimits';

import type { CoordinationJsonValue } from '../../contracts';

function invalidEvent(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): SnapshotEventHandoffError {
  return new SnapshotEventHandoffError('invalid_coordination_event', message, details);
}

/**
 * Materializes adapter-owned snapshot data as a fresh accessor-free immutable
 * tree. Only data that can actually be made deeply immutable is admitted:
 * primitives, dense arrays, and plain records. Mutable built-in objects,
 * prototypes, symbols, hidden properties, accessors, and cycles fail closed.
 */
export function materializeCoordinationSnapshotData<TSnapshot>(value: TSnapshot): TSnapshot {
  const ancestors = new Set<object>();
  let materializedNodeCount = 0;

  const invalidSnapshot = (
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ): SnapshotEventHandoffError =>
    new SnapshotEventHandoffError('invalid_snapshot_data', message, details);

  const materialize = (current: unknown, depth: number): unknown => {
    materializedNodeCount += 1;
    if (materializedNodeCount > MAX_COORDINATION_SNAPSHOT_NODES) {
      throw invalidSnapshot('Coordination snapshot exceeds its total-node budget', {
        maximumNodes: MAX_COORDINATION_SNAPSHOT_NODES,
      });
    }
    if (depth > MAX_COORDINATION_SNAPSHOT_DEPTH) {
      throw invalidSnapshot('Coordination snapshot exceeds its nesting-depth budget', {
        maximumDepth: MAX_COORDINATION_SNAPSHOT_DEPTH,
      });
    }
    if (
      current === null ||
      current === undefined ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      typeof current === 'number' ||
      typeof current === 'bigint'
    ) {
      return current;
    }
    if (typeof current !== 'object') {
      throw invalidSnapshot('Coordination snapshot must contain only detached data');
    }
    if (ancestors.has(current)) {
      throw invalidSnapshot('Coordination snapshot must be acyclic');
    }

    const prototype = Object.getPrototypeOf(current) as unknown;
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw invalidSnapshot(
        'Coordination snapshot must contain only arrays and plain data objects'
      );
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const ownKeys = Reflect.ownKeys(current);
        if (
          ownKeys.length !== current.length + 1 ||
          ownKeys.some(
            (key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))
          )
        ) {
          throw invalidSnapshot(
            'Coordination snapshot arrays must contain only dense data indices'
          );
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw invalidSnapshot(
              'Coordination snapshot arrays cannot contain sparse indices or accessors'
            );
          }
          result.push(materialize(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }

      const ownKeys = Reflect.ownKeys(current);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          throw invalidSnapshot(
            'Coordination snapshot objects cannot contain symbols or hidden properties'
          );
        }
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable) {
          throw invalidSnapshot(
            'Coordination snapshot objects cannot contain symbols or hidden properties'
          );
        }
        if (!('value' in descriptor)) {
          throw invalidSnapshot('Coordination snapshot objects cannot contain accessors');
        }
        Object.defineProperty(result, key, {
          value: materialize(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  };

  return materialize(value, 0) as TSnapshot;
}

/**
 * Copies untrusted payload data into an accessor-free immutable JSON tree
 * before the canonical budget validator observes it. Property descriptors are
 * inspected without invoking getters, so a value cannot change between
 * validation and the durable append.
 */
export function materializeCoordinationJsonPayload(value: unknown): CoordinationJsonValue {
  const ancestors = new Set<object>();
  let materializedNodeCount = 0;

  const materialize = (current: unknown, depth: number): CoordinationJsonValue => {
    materializedNodeCount += 1;
    if (materializedNodeCount > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
      throw invalidEvent('Coordination event payload exceeds its total-node budget', {
        maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
      });
    }
    if (depth > MAX_COORDINATION_EVENT_PAYLOAD_DEPTH) {
      throw invalidEvent('Coordination event payload exceeds its nesting-depth budget', {
        maximumDepth: MAX_COORDINATION_EVENT_PAYLOAD_DEPTH,
      });
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw invalidEvent('Coordination event payload must be strict JSON');
      }
      return current;
    }
    if (typeof current !== 'object' || ancestors.has(current)) {
      throw invalidEvent('Coordination event payload must be strict acyclic JSON');
    }

    const prototype = Object.getPrototypeOf(current) as unknown;
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw invalidEvent('Coordination event payload must contain only plain JSON objects');
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (materializedNodeCount + current.length > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
          throw invalidEvent('Coordination event payload exceeds its total-node budget', {
            maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
          });
        }
        const ownPropertySymbols = Object.getOwnPropertySymbols(current);
        const ownPropertyNames = Object.getOwnPropertyNames(current);
        if (ownPropertySymbols.length > 0 || ownPropertyNames.length !== current.length + 1) {
          throw invalidEvent('Coordination event payload arrays must contain only JSON indices');
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const result: CoordinationJsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw invalidEvent(
              'Coordination event payload cannot contain sparse arrays or accessors'
            );
          }
          result.push(materialize(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }

      const ownKeys = Reflect.ownKeys(current);
      if (materializedNodeCount + ownKeys.length > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
        throw invalidEvent('Coordination event payload exceeds its total-node budget', {
          maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
        });
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const result = Object.create(null) as Record<string, CoordinationJsonValue>;
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          throw invalidEvent(
            'Coordination event payload objects cannot contain symbols or hidden properties'
          );
        }
        const descriptor = descriptors[key];
        if (!descriptor.enumerable) {
          throw invalidEvent(
            'Coordination event payload objects cannot contain symbols or hidden properties'
          );
        }
        if (!('value' in descriptor)) {
          throw invalidEvent('Coordination event payload objects cannot contain accessors');
        }
        Object.defineProperty(result, key, {
          value: materialize(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  };

  const payload = materialize(value, 0);
  assertCoordinationJsonPayload(payload);
  return payload;
}

export function assertCoordinationJsonPayload(
  value: unknown
): asserts value is CoordinationJsonValue {
  type WorkItem =
    | { readonly kind: 'value'; readonly value: unknown; readonly depth: number }
    | { readonly kind: 'leave'; readonly value: object };

  const work: WorkItem[] = [{ kind: 'value', value, depth: 0 }];
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  let nodeCount = 0;
  let scheduledNodeCount = 1;
  let byteCount = 0;

  const addBytes = (count: number): void => {
    byteCount += count;
    if (byteCount > MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES) {
      throw invalidEvent('Coordination event payload exceeds its UTF-8 byte budget', {
        maximumBytes: MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES,
      });
    }
  };
  const addJsonStringBytes = (input: string): void => {
    if (input.length + 2 > MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES - byteCount) {
      throw invalidEvent('Coordination event payload exceeds its UTF-8 byte budget', {
        maximumBytes: MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES,
      });
    }
    addBytes(encoder.encode(JSON.stringify(input)).byteLength);
  };
  const scheduleNodes = (count: number): void => {
    scheduledNodeCount += count;
    if (scheduledNodeCount > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
      throw invalidEvent('Coordination event payload exceeds its total-node budget', {
        maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
      });
    }
  };

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === 'leave') {
      ancestors.delete(item.value);
      continue;
    }

    nodeCount += 1;
    if (nodeCount > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
      throw invalidEvent('Coordination event payload exceeds its total-node budget', {
        maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
      });
    }
    if (item.depth > MAX_COORDINATION_EVENT_PAYLOAD_DEPTH) {
      throw invalidEvent('Coordination event payload exceeds its nesting-depth budget', {
        maximumDepth: MAX_COORDINATION_EVENT_PAYLOAD_DEPTH,
      });
    }

    const current = item.value;
    if (current === null) {
      addBytes(4);
      continue;
    }
    if (typeof current === 'string') {
      addJsonStringBytes(current);
      continue;
    }
    if (typeof current === 'boolean') {
      addBytes(current ? 4 : 5);
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw invalidEvent('Coordination event payload must be strict JSON');
      }
      addBytes(String(Object.is(current, -0) ? 0 : current).length);
      continue;
    }
    if (typeof current !== 'object' || ancestors.has(current)) {
      throw invalidEvent('Coordination event payload must be strict acyclic JSON');
    }

    const prototype = Object.getPrototypeOf(current) as unknown;
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw invalidEvent('Coordination event payload must contain only plain JSON objects');
    }
    ancestors.add(current);
    work.push({ kind: 'leave', value: current });

    if (Array.isArray(current)) {
      addBytes(2 + Math.max(0, current.length - 1));
      scheduleNodes(current.length);
      if (
        Object.getOwnPropertySymbols(current).length > 0 ||
        Object.getOwnPropertyNames(current).length !== current.length + 1
      ) {
        throw invalidEvent('Coordination event payload arrays must contain only JSON indices');
      }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (!(index in current)) {
          throw invalidEvent('Coordination event payload cannot contain sparse arrays');
        }
        work.push({ kind: 'value', value: current[index], depth: item.depth + 1 });
      }
      continue;
    }

    const record = current as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record);
    addBytes(2 + Math.max(0, keys.length - 1) + keys.length);
    scheduleNodes(keys.length);
    if (Reflect.ownKeys(record).length !== keys.length) {
      throw invalidEvent(
        'Coordination event payload objects cannot contain symbols or hidden properties'
      );
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      addJsonStringBytes(key);
      work.push({ kind: 'value', value: record[key], depth: item.depth + 1 });
    }
  }
}

export function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameStructuredValue(item, right[index]))
    );
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameStructuredValue(leftRecord[key], rightRecord[key])
    )
  );
}
