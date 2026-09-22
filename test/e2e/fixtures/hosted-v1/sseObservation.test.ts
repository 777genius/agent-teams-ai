import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSseObservation, type SseObservationState } from '../../../fixtures/hosted-v1/sseObservation';

class FakeEventSource {
  static CLOSED = 2;
  static latest: FakeEventSource;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: unknown) => void>();
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { FakeEventSource.latest = this; }
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, listener); }
  frame(name: string, data: unknown, lastEventId = '') {
    this.listeners.get(name)?.({ data: JSON.stringify(data), lastEventId });
  }
}

function setup(expectedType: string | undefined = 'team-lifecycle.run-accepted') {
  vi.useFakeTimers();
  const scope = { setTimeout, clearTimeout, __hostedTracedSse: undefined as SseObservationState | undefined };
  vi.stubGlobal('window', scope);
  vi.stubGlobal('EventSource', FakeEventSource);
  installSseObservation({ after: 'cursor-0', expectedType });
  return { state: scope.__hostedTracedSse!, source: FakeEventSource.latest };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('phase 8 SSE observer', () => {
  it('fails immediately on real-shaped resync before applying the lifecycle filter', () => {
    const { state, source } = setup();
    source.frame('resync_required', { kind: 'resync_required', reason: 'cursor_expired' });
    expect(state.terminalError).toBe('resync_required:cursor_expired');
    expect(state.event).toBeNull();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(25_000);
    expect(state.terminalError).toBe('resync_required:cursor_expired');
  });

  it('preserves explicit expiry observations without a lifecycle filter', () => {
    const { state, source } = setup('unused');
    installSseObservation({ after: 'expired-cursor' });
    FakeEventSource.latest.frame('resync_required', { kind: 'resync_required', reason: 'cursor_expired' });
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(state.event).toBeNull();
    const current = (window as typeof window & { __hostedTracedSse: SseObservationState }).__hostedTracedSse;
    expect(current.event).toMatchObject({ eventType: 'resync_required', data: { reason: 'cursor_expired' } });
    expect(current.terminalError).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails on a lost event cursor even for a filtered task event', () => {
    const { state, source } = setup();
    source.frame('coordination_event', { eventType: 'team.task.external_observed' });
    expect(state.terminalError).toBe('event_cursor_missing');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('filters task frames and accepts the retained lifecycle cursor without recording payloads', () => {
    const { state, source } = setup();
    source.frame('coordination_event', { eventType: 'team.task.external_observed', secret: 'private-body' }, 'cursor-1');
    expect(state.event).toBeNull();
    source.frame('coordination_event', { eventType: 'team-lifecycle.run-accepted' }, 'cursor-2');
    expect(state.event?.id).toBe('cursor-2');
    expect(state.trace.join('\n')).not.toContain('private-body');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds reconnects by the original deadline and retains a bounded transition trace', () => {
    const { state, source } = setup();
    source.onopen?.();
    vi.advanceTimersByTime(24_000);
    for (let i = 0; i < 100; i += 1) { source.onerror?.(); source.onopen?.(); }
    vi.advanceTimersByTime(1_000);
    expect(state.terminalError).toBe('observation_timeout');
    expect(state.trace.length).toBeLessThanOrEqual(64);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes and clears its timer on malformed JSON without retaining the body', () => {
    const { state, source } = setup();
    source.listeners.get('coordination_event')?.({ data: 'private-invalid-json', lastEventId: 'cursor-1' });
    expect(state.terminalError).toBe('event_json_invalid');
    expect(state.trace.join('\n')).not.toContain('private-invalid-json');
    state.dispose();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates a permanently closed transport', () => {
    const { state, source } = setup();
    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.();
    expect(state.terminalError).toBe('transport_closed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
