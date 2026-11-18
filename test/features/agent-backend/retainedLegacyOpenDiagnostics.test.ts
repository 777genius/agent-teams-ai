// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createRetainedLegacyOpenDiagnostic } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createRetainedLegacyOpenDiagnostic';
import {
  RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES,
  type RetainedLegacyOpenDiagnostic,
} from '../../../src/features/agent-backend/main/infrastructure/stopped-import/retainedLegacyOpenDiagnosticContract';

const request = { action: 'open', teamName: 'TEST-private-team', intentId: 'TEST-private-intent' };
const failure = { ok: false, reason: 'unavailable', outcome: 'not-dispatched' };
const expectedHash = createHash('sha256')
  .update(JSON.stringify(['open', request.teamName, request.intentId]), 'utf8')
  .digest('hex');

describe('private retained original open diagnostic', () => {
  it.each(RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES)(
    'binds one closed %s observation to the original Main and request strings',
    (phase) => {
      const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
      const observe = createRetainedLegacyOpenDiagnostic(request, 1234, sink);
      observe.finish(phase, failure);
      observe.finish('coordinator', { ...failure, outcome: 'unknown' });
      expect(sink).toHaveBeenCalledExactlyOnceWith({
        v: 1,
        mainPid: 1234,
        operationHash: expectedHash,
        phase,
        category: 'unavailable',
        outcome: 'not-dispatched',
      });
      expect(JSON.stringify(sink.mock.calls)).not.toMatch(/TEST-private|teamName|intentId/);
    }
  );

  it('keeps the first normalized failure private until the original cleanup outcome exists', () => {
    const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
    const readPrivate = vi.fn(() => 'PRIVATE-error');
    const error = Object.defineProperty({ code: 'EACCES' }, 'message', { get: readPrivate });
    const observe = createRetainedLegacyOpenDiagnostic(request, 1234, sink);
    observe.remember('runtime-capture', error);
    error.code = 'ENOENT';
    observe.remember('coordinator-admission', { code: 'ETIMEDOUT' });
    expect(sink).not.toHaveBeenCalled();
    observe.finish('coordinator', { ok: false, reason: 'outcome-unknown', outcome: 'unknown' });
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      v: 1,
      mainPid: 1234,
      operationHash: expectedHash,
      phase: 'runtime-capture',
      category: 'denied',
      outcome: 'unknown',
    });
    expect(readPrivate).not.toHaveBeenCalled();
    expect(JSON.stringify(sink.mock.calls)).not.toContain('PRIVATE');
  });

  it('does not turn a recovered original result into a refusal or observe later reuse', () => {
    const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
    const observe = createRetainedLegacyOpenDiagnostic(request, 1234, sink);
    observe.remember('target-capture', new Error('PRIVATE'));
    observe.finish('coordinator-admission', { ok: true, action: 'open', value: {} });
    observe.finish('coordinator', failure);
    expect(sink).not.toHaveBeenCalled();
  });

  it('hashes the captured original strings without later mutation or normalization', () => {
    const original = { ...request };
    const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
    const observe = createRetainedLegacyOpenDiagnostic(original, 1234, sink);
    original.teamName = 'TEST-other-team';
    original.intentId = 'TEST-other-intent';
    observe.finish('source-owner', failure);
    expect(sink.mock.calls[0]?.[0].operationHash).toBe(expectedHash);
    const changed = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
    createRetainedLegacyOpenDiagnostic(original, 1234, changed).finish('source-owner', failure);
    expect(changed.mock.calls[0]?.[0].operationHash).not.toBe(expectedHash);
  });

  it('never reads request or result accessors and refuses unbound or malformed requests', () => {
    const getter = vi.fn(() => 'PRIVATE');
    const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
    for (const key of ['action', 'teamName', 'intentId']) {
      const input = { ...request };
      Object.defineProperty(input, key, { get: getter });
      createRetainedLegacyOpenDiagnostic(input, 1234, sink).finish('source-owner', failure);
    }
    for (const input of [
      { ...request, action: 'closeIntent' },
      { ...request, teamName: '../PRIVATE' },
      { ...request, intentId: 'short' },
      { ...request, intentId: 'a'.repeat(129) },
      { ...request, extra: 'PRIVATE' },
      Object.create(request),
      new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('PRIVATE'); } }),
    ]) {
      createRetainedLegacyOpenDiagnostic(input, 1234, sink).finish('source-owner', failure);
    }
    for (const mainPid of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      createRetainedLegacyOpenDiagnostic(request, mainPid, sink).finish('source-owner', failure);
    }
    for (const key of ['ok', 'outcome']) {
      const result = { ...failure };
      Object.defineProperty(result, key, { get: getter });
      createRetainedLegacyOpenDiagnostic(request, 1234, sink).finish('source-owner', result);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it('uses only existing own-data error categories without arbitrary error text', () => {
    const getter = vi.fn(() => 'PRIVATE');
    const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
    const error = Object.create({ code: 'EACCES' });
    for (const key of ['code', 'reason', 'name', 'message', 'stack', 'cause']) {
      Object.defineProperty(error, key, { get: getter });
    }
    const observe = createRetainedLegacyOpenDiagnostic(request, 1234, sink);
    observe.remember('target-capture', error);
    observe.finish('coordinator', failure);
    expect(sink.mock.calls[0]?.[0].category).toBe('unknown');
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(sink.mock.calls)).not.toContain('PRIVATE');
  });

  for (const mode of ['throw', 'reject', 'then-getter'] as const) {
    it('contains observer ' + mode + ' without another record or result access', async () => {
      const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>(() => {
        if (mode === 'throw') throw new Error('PRIVATE-sink');
        if (mode === 'reject') return Promise.reject(new Error('PRIVATE-sink'));
        return Object.defineProperty({}, 'then', {
          get: () => { throw new Error('PRIVATE-then'); },
        });
      });
      const observe = createRetainedLegacyOpenDiagnostic(request, 1234, sink);
      expect(() => observe.finish('source-owner', failure)).not.toThrow();
      observe.finish('source-owner', failure);
      await Promise.resolve();
      await Promise.resolve();
      expect(sink).toHaveBeenCalledTimes(1);
    });
  }

  it('drops forged phases and outcomes instead of extending the private schema', () => {
    const sink = vi.fn<(observation: RetainedLegacyOpenDiagnostic) => unknown>();
    createRetainedLegacyOpenDiagnostic(request, 1234, sink).finish('PRIVATE' as never, failure);
    createRetainedLegacyOpenDiagnostic(request, 1234, sink).finish('source-owner', {
      ...failure,
      outcome: 'PRIVATE',
    });
    expect(sink).not.toHaveBeenCalled();
  });
});
