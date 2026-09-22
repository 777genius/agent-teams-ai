export interface SseObservationState {
  requestedCursor: string;
  httpStatus: number | null;
  event: { eventType: string; data: Record<string, unknown>; id: string } | null;
  open: boolean;
  terminalError: string | null;
  trace: string[];
  dispose: () => void;
}

// Self-contained so Playwright can serialize this exact function into the observer page.
export function installSseObservation(input: { after: string; expectedType?: string }): void {
  const scope = window as typeof window & { __hostedTracedSse?: SseObservationState };
  scope.__hostedTracedSse?.dispose();
  const source = new EventSource(`/api/hosted/v1/events?after=${encodeURIComponent(input.after)}`);
  const state: SseObservationState = {
    requestedCursor: input.after, httpStatus: null, event: null, open: false, terminalError: null, trace: [], dispose: () => undefined,
  };
  scope.__hostedTracedSse = state;
  // Only protocol metadata is retained, never frame bodies, auth or provider values.
  const record = (value: string) => {
    state.trace.push(value.slice(0, 2300));
    if (state.trace.length > 64) state.trace.splice(1, 1);
  };
  record(`requested:${input.after}`);
  let settled = false;
  state.dispose = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    source.close();
  };
  const fail = (code: string) => {
    if (settled) return;
    state.terminalError = code;
    record(`terminal:${code}`);
    state.dispose();
  };
  const timer = window.setTimeout(() => fail('observation_timeout'), 25_000);
  source.onopen = () => { if (!settled) { state.open = true; record('open'); } };
  source.onerror = () => {
    if (settled) return;
    state.open = false;
    record(`error:readyState=${source.readyState}`);
    if (source.readyState === EventSource.CLOSED) fail('transport_closed');
  };
  const receive = (eventType: string, event: MessageEvent) => {
    if (settled) return;
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      data = parsed as Record<string, unknown>;
    } catch {
      record(`event:name=${eventType}:id=${event.lastEventId}:type=invalid_json`);
      fail('event_json_invalid');
      return;
    }
    const type = typeof data.eventType === 'string' && /^[\w.-]{1,120}$/u.test(data.eventType)
      ? data.eventType : 'unknown';
    record(`event:name=${eventType}:id=${event.lastEventId}:type=${type}`);
    if (eventType === 'resync_required') {
      const reasons = ['cursor_expired', 'malformed_cursor', 'foreign_deployment', 'foreign_epoch', 'cursor_ahead', 'event_gap', 'projection_invalid'];
      const reason = typeof data.reason === 'string' && reasons.includes(data.reason) ? data.reason : 'unknown';
      record(`resync:${reason}`);
      if (input.expectedType !== undefined) { fail(`resync_required:${reason}`); return; }
    } else {
      if (!event.lastEventId) { fail('event_cursor_missing'); return; }
      if (input.expectedType !== undefined && data.eventType !== input.expectedType) return;
    }
    state.event = { eventType, data, id: event.lastEventId };
    record(`terminal:${eventType}`);
    state.dispose();
  };
  source.addEventListener('coordination_event', (event) => receive('coordination_event', event as MessageEvent));
  source.addEventListener('resync_required', (event) => receive('resync_required', event as MessageEvent));
}
