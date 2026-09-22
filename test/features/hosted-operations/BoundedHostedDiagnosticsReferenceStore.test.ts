import {
  createRetentionBudget,
  parseOperationalReferenceId,
} from '@features/hosted-operations/contracts';
import { BoundedHostedDiagnosticsReferenceStore } from '@features/hosted-operations/main/adapters/output/BoundedHostedDiagnosticsReferenceStore';
import { createQueryContext, type QueryContext } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedDiagnosticsSourceRecord } from '@features/hosted-operations/main/hosted';

const PRIVATE_DETAIL = ['sensitive', 'runtime', 'detail'].join('-');

function queryContextInput(
  overrides: Partial<{
    actorId: string;
    sessionId: string;
    deploymentId: string;
    bootId: string;
    requestId: string;
    authorizedScope: string;
    deadlineAtMs: number;
    signal: AbortSignal;
  }> = {}
) {
  return {
    actorId: 'actor_diagnostics-store',
    sessionId: 'session_diagnostics-store',
    deploymentId: 'deployment_diagnostics-store',
    bootId: 'boot_diagnostics-store',
    requestId: 'request_diagnostics-store',
    authorizedScope: 'scope_diagnostics-store',
    deadlineAtMs: 10_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function context(overrides: Parameters<typeof queryContextInput>[0] = {}): QueryContext {
  return createQueryContext(queryContextInput(overrides));
}

function sourceRecord(attributes: unknown = {}): HostedDiagnosticsSourceRecord {
  return {
    kind: 'reference_load',
    outcome: 'failed',
    occurredAtMonotonicMs: 7,
    attributes,
  };
}

function referenceId(fill: number) {
  return parseOperationalReferenceId(`reference_${fill.toString(16).padStart(2, '0').repeat(16)}`);
}

function harness(
  identifiers: number[] = [],
  retentionBudget = { maxEntries: 8, maxAgeMs: 100, maxTotalBytes: 10_000 }
) {
  let epochMs = 1_000;
  let monotonicMs = 0;
  let generated = 0;
  const store = new BoundedHostedDiagnosticsReferenceStore({
    retentionBudget: createRetentionBudget(retentionBudget),
    platform: {
      nowEpochMs: () => epochMs,
      nowMonotonicMs: () => monotonicMs,
    },
    generateReferenceId: vi.fn(() => referenceId(identifiers.shift() ?? ++generated)),
  });
  return {
    store,
    setEpochMs(value: number) {
      epochMs = value;
    },
    setMonotonicMs(value: number) {
      monotonicMs = value;
    },
  };
}

describe('BoundedHostedDiagnosticsReferenceStore', () => {
  it('stores only a frozen safe projection and its server-computed byte length', async () => {
    const { store } = harness([1]);
    const attributes = {
      component: 'reference_loader',
      operation: 'load',
      reason: PRIVATE_DETAIL,
      location: ['private', 'location'].join('-'),
    };
    const input = sourceRecord(attributes);
    const id = store.record(input, context());

    attributes.component = 'team_controller';
    attributes.operation = 'launch';
    attributes.reason = 'source_failed';
    const loaded = await store.load(id, context({ requestId: 'request_second' }));
    const expectedValue = {
      kind: 'reference_load',
      outcome: 'failed',
      occurredAtMonotonicMs: 7,
      attributes: {
        component: 'reference_loader',
        operation: 'load',
        reason: 'redacted',
      },
    };

    expect(loaded).toEqual({
      value: expectedValue,
      byteLength: new TextEncoder().encode(JSON.stringify(expectedValue)).byteLength,
    });
    expect(JSON.stringify(loaded)).not.toContain(PRIVATE_DETAIL);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.value)).toBe(true);
    expect(Object.isFrozen(loaded.value.attributes)).toBe(true);
  });

  it('reads proxy data through descriptors and rejects accessors without invoking getters', async () => {
    const { store } = harness([2, 3]);
    let recordReads = 0;
    const recordTarget = sourceRecord({ state: 'ready' });
    const recordProxy = new Proxy(recordTarget, {
      get(target, key, receiver) {
        recordReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    let contextReads = 0;
    const contextProxy = new Proxy(queryContextInput(), {
      get(target, key, receiver) {
        contextReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const id = store.record(recordProxy, contextProxy as unknown as QueryContext);

    expect(recordReads).toBe(0);
    expect(contextReads).toBe(0);
    await expect(store.load(id, context())).resolves.toMatchObject({
      value: { attributes: { state: 'ready' } },
    });

    let recordGetterReads = 0;
    const recordAccessor = Object.defineProperty(sourceRecord(), 'kind', {
      enumerable: true,
      get() {
        recordGetterReads += 1;
        return 'reference_load';
      },
    });
    let contextGetterReads = 0;
    const contextAccessor = Object.defineProperty(queryContextInput(), 'actorId', {
      enumerable: true,
      get() {
        contextGetterReads += 1;
        return 'actor_diagnostics-store';
      },
    });

    expect(() => store.record(recordAccessor, context())).toThrow('hosted-diagnostics-unavailable');
    expect(() => store.record(sourceRecord(), contextAccessor as unknown as QueryContext)).toThrow(
      'hosted-diagnostics-unavailable'
    );
    expect(recordGetterReads).toBe(0);
    expect(contextGetterReads).toBe(0);
  });

  it('uses one failure for missing, expired, and mismatched actor/session/deployment/scope', async () => {
    const state = harness([4], { maxEntries: 4, maxAgeMs: 10, maxTotalBytes: 10_000 });
    const owner = context();
    const id = state.store.record(sourceRecord(), owner);
    const missing = referenceId(255);
    const mismatches = [
      context({ actorId: 'actor_other' }),
      context({ sessionId: 'session_other' }),
      context({ deploymentId: 'deployment_other' }),
      context({ authorizedScope: 'scope_other' }),
    ];

    const messages = await Promise.all([
      state.store.load(missing, owner).catch((error: Error) => error.message),
      ...mismatches.map((candidate) =>
        state.store.load(id, candidate).catch((error: Error) => error.message)
      ),
    ]);
    await expect(
      state.store.load(id, context({ bootId: 'boot_other', requestId: 'request_other' }))
    ).resolves.toBeDefined();
    state.setMonotonicMs(11);
    messages.push(await state.store.load(id, owner).catch((error: Error) => error.message));

    expect(new Set(messages)).toEqual(new Set(['hosted-diagnostics-unavailable']));
  });

  it('retries collisions without overwriting and bounds collision attempts', async () => {
    const state = harness([5, 5, 6, ...Array<number>(8).fill(5)]);
    const owner = context();
    const first = state.store.record(sourceRecord({ state: 'ready' }), owner);
    const second = state.store.record(sourceRecord({ state: 'degraded' }), owner);

    expect(first).toBe(referenceId(5));
    expect(second).toBe(referenceId(6));
    expect(() => state.store.record(sourceRecord({ state: 'active' }), owner)).toThrow(
      'hosted-diagnostics-unavailable'
    );
    await expect(state.store.load(first, owner)).resolves.toMatchObject({
      value: { attributes: { state: 'ready' } },
    });
    await expect(state.store.load(second, owner)).resolves.toMatchObject({
      value: { attributes: { state: 'degraded' } },
    });
  });

  it('applies count, age, and byte retention budgets', async () => {
    const state = harness([7, 8, 9], {
      maxEntries: 2,
      maxAgeMs: 5,
      maxTotalBytes: 10_000,
    });
    const owner = context();
    const first = state.store.record(sourceRecord({ state: 'active' }), owner);
    state.setMonotonicMs(1);
    const second = state.store.record(sourceRecord({ state: 'ready' }), owner);
    state.setMonotonicMs(2);
    const third = state.store.record(sourceRecord({ state: 'degraded' }), owner);

    await expect(state.store.load(first, owner)).rejects.toThrow('hosted-diagnostics-unavailable');
    await expect(state.store.load(second, owner)).resolves.toBeDefined();
    state.setMonotonicMs(7);
    await expect(state.store.load(second, owner)).rejects.toThrow('hosted-diagnostics-unavailable');
    await expect(state.store.load(third, owner)).resolves.toBeDefined();

    const byteBounded = harness([10], {
      maxEntries: 2,
      maxAgeMs: 100,
      maxTotalBytes: 0,
    });
    expect(() => byteBounded.store.record(sourceRecord(), owner)).toThrow(
      'hosted-diagnostics-unavailable'
    );
  });

  it('fails closed for aborts and deadlines and invalidates all records on close', async () => {
    const state = harness([11]);
    const owner = context();
    const id = state.store.record(sourceRecord(), owner);
    const aborted = new AbortController();
    aborted.abort();

    expect(() => state.store.record(sourceRecord(), context({ signal: aborted.signal }))).toThrow(
      'hosted-diagnostics-unavailable'
    );
    await expect(state.store.load(id, context({ signal: aborted.signal }))).rejects.toThrow(
      'hosted-diagnostics-unavailable'
    );
    state.setEpochMs(10_000);
    await expect(state.store.load(id, owner)).rejects.toThrow('hosted-diagnostics-unavailable');

    state.store.close();
    state.store.close();
    await expect(state.store.load(id, context())).rejects.toThrow('hosted-diagnostics-unavailable');
    expect(() => state.store.record(sourceRecord(), context())).toThrow(
      'hosted-diagnostics-unavailable'
    );
  });
});
