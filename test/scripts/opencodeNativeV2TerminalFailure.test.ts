import { describe, expect, it } from 'vitest';

import { projectV2OwnedSessionDiagnostic, projectV2TerminalErrorCode, projectV2TerminalErrorType, projectV2TerminalFailure, reprojectV2OwnedSessionDiagnostic } from '../../scripts/e2e/opencode-diagnostics/v2-terminal-failure';
const expected = { sessionId: 'ses_TEST', nativeInputId: 'msg_TEST' };
function fixture() {
  const event = (seq: number, type: string, data: Record<string, unknown>): { id: string; seq: number; type: string; aggregateID: string; data: Record<string, unknown> } => ({ id: `evt_${seq}`, seq, type, aggregateID: expected.sessionId, data: { sessionID: expected.sessionId, ...data } });
  return { messages: { previous: null, next: null, data: [{ id: 'msg_TEST', type: 'user' }] }, log: { synced: true, watermark: 3, events: [
    event(0, 'session.execution.started', {}), event(1, 'session.inbox.delivered', { inboxID: 'msg_TEST' }), event(2, 'session.step.ended', { finish: 'length' }),
    event(3, 'session.execution.failed', { error: { type: 'ContextOverflowError', message: 'SECRET/path/token', code: 'context_length_exceeded', statusCode: 400 } }),
  ] } };
}
describe('exact original V2 terminal diagnostic', () => {
  it('preserves the native 2.1.4 output-limit error without its raw message or response', () => {
    const f = fixture();
    // Native SessionRunner.continueOutputLimit emits this error after three
    // assistant messages end with length; the execution terminal carries it unchanged.
    f.log.events[3]!.data.error = {
      type: 'output-limit',
      message: 'Response still truncated after two output token limit continuations',
      response: { body: 'SECRET/path/token' },
    };
    const result = projectV2TerminalFailure(f, expected);
    expect(result).toEqual({
      source: 'exact_original_owned_native_event', terminalType: 'session.execution.failed',
      errorType: 'output-limit', errorCode: null, httpStatus: null, lastStepFinish: 'length',
    });
    expect(projectV2TerminalErrorType(result.errorType)).toBe('output-limit');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|truncated|message|response/);
  });
  it.each(['provider.auth', 'provider.rate-limit', 'provider.quota', 'permission.rejected', 'tool.execution'])('keeps the finite native %s type across child and parent projection', type => {
    const f = fixture();
    f.log.events[3]!.data.error = { type, message: 'SECRET', status: 429 };
    const result = projectV2TerminalFailure(f, expected);
    expect(result).toMatchObject({ errorType: type, httpStatus: 429 });
    expect(projectV2TerminalErrorType(result.errorType)).toBe(type);
  });
  it('parent validation refuses arbitrary tokens even when their spelling looks safe', () => {
    expect(projectV2TerminalErrorType('SECRET_TOKEN')).toBeNull();
    expect(projectV2TerminalErrorType('provider.SECRET')).toBeNull();
    expect(projectV2TerminalErrorCode('SECRET_TOKEN')).toBeNull();
    expect(projectV2TerminalErrorCode('context_length_exceeded')).toBe('context_length_exceeded');
  });
  it('keeps finite native cause and correlated finish while dropping raw fields', () => {
    const result = projectV2TerminalFailure(fixture(), expected);
    expect(result).toMatchObject({ terminalType: 'session.execution.failed', errorType: 'ContextOverflowError', errorCode: 'context_length_exceeded', httpStatus: 400, lastStepFinish: 'length' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('does not infer context failure from length alone', () => {
    const f = fixture(); f.log.events[3]!.data = { sessionID: 'ses_TEST', error: { type: 'SECRET', code: 'SECRET', message: 'context_length_exceeded' } };
    expect(projectV2TerminalFailure(f, expected)).toMatchObject({ errorType: null, errorCode: null, lastStepFinish: 'length' });
  });
  it.each(['foreign', 'duplicate', 'watermark', 'interleaved', 'prior-delivery', 'prior-step'] as const)('refuses %s lineage', mode => {
    const f = fixture();
    if (mode === 'foreign') f.log.events[3]!.aggregateID = 'ses_OTHER';
    if (mode === 'duplicate') f.log.events[1]!.id = f.log.events[0]!.id;
    if (mode === 'watermark') f.log.watermark = 2;
    if (mode === 'prior-delivery') f.log.events[0]!.type = 'session.inbox.delivered';
    if (mode === 'prior-step') f.log.events[0]!.type = 'session.step.started';
    if (mode === 'interleaved') f.log.events[2]!.type = 'session.inbox.delivered';
    expect(() => projectV2TerminalFailure(f, expected)).toThrow();
  });
});

function candidateFixture() {
  const f = fixture();
  f.messages.data[0] = { id: 'msg_TEST', type: 'user', data: {
    id: 'msg_TEST', type: 'user', text: 'SECRET original prompt',
  } } as typeof f.messages.data[0];
  f.log.events.unshift({ id: 'evt_enqueue', seq: 0, type: 'session.inbox.enqueued', aggregateID: 'ses_TEST',
    data: { sessionID: 'ses_TEST', inboxID: 'msg_TEST', item: { type: 'user', delivery: 'queue', payload: { text: 'SECRET original prompt' } } } });
  f.log.events.forEach((event, seq) => { event.seq = seq; });
  f.log.watermark = f.log.events.at(-1)!.seq;
  f.log.events.at(-1)!.data.error = { type: 'provider.quota', message: 'SECRET provider error', response: { body: 'SECRET body' }, status: 429 };
  return f;
}
describe('owned session fallback diagnostics', () => {
  it.each([null, 'msg_missing'])('retains last terminal cause when requested input is %s, without attribution or raw data', nativeInputId => {
    const f = candidateFixture();
    const diagnostic = projectV2OwnedSessionDiagnostic(f, { sessionId: 'ses_TEST', nativeInputId }, '2.1.4', input => {
      expect(input).toMatchObject({ pin: '2.1.4', nativeInputID: 'msg_TEST', beforeCursor: -1, originalText: 'SECRET original prompt' });
      expect(input.messages).toBe(f.messages);
      expect(input.log).toBe(f.log);
      return { state: 'unknown', reason: 'missing_step_terminal', text: 'SECRET projection text' };
    });
    expect(diagnostic.requestedInput).toBe(nativeInputId === null ? 'unknown' : 'absent');
    expect(diagnostic.terminalEvent).toMatchObject({ source: 'owned_session_last_terminal',
      attribution: 'no_requested_input_attribution', errorType: 'provider.quota', httpStatus: 429 });
    expect(diagnostic.candidateProjection).toEqual({ source: 'last_materialized_user_not_actual_occupied_slot',
      attribution: 'no_requested_input_attribution', boundary: 'native_enqueue_seq_minus_one', state: 'unknown',
      reason: 'missing_step_terminal', enqueuePresent: true, deliveryPresent: true, terminalPresent: true, idlePresent: false });
    expect(JSON.stringify(diagnostic)).not.toMatch(/SECRET|msg_TEST|ses_TEST|originalText|response|body/);
    expect(reprojectV2OwnedSessionDiagnostic(diagnostic)).toEqual(diagnostic);
  });
  it('keeps requested attribution only when that original is materialized', () => {
    const diagnostic = projectV2OwnedSessionDiagnostic(candidateFixture(), expected, '2.1.4', () => ({ state: 'failed', reason: 'session.execution.failed' }));
    expect(diagnostic.requestedInput).toBe('present');
    expect(diagnostic.terminalEvent).toMatchObject({ source: 'exact_original_owned_native_event', errorType: 'provider.quota' });
  });
  it('does not guess a boundary when enqueue evidence is absent', () => {
    let called = false;
    const diagnostic = projectV2OwnedSessionDiagnostic(fixture(), { ...expected, nativeInputId: null }, '2.1.4', () => {
      called = true; return { state: 'failed', reason: 'session.execution.failed' };
    });
    expect(called).toBe(false);
    expect(diagnostic.candidateProjection).toEqual({ observation: 'unavailable' });
    expect(diagnostic.terminalEvent).toMatchObject({ source: 'owned_session_last_terminal' });
  });
  it('never falls back to an earlier terminal when the latest interval has ambiguous input lineage', () => {
    const f = candidateFixture();
    const tail = f.log.events.at(-1)!;
    f.log.events.push({ ...tail, id: 'evt_later', seq: tail.seq + 1 });
    f.log.watermark++;
    const diagnostic = projectV2OwnedSessionDiagnostic(f, { ...expected, nativeInputId: null }, '2.1.4', () => ({ state: 'unknown', reason: 'terminal_snapshot_mismatch' }));
    expect(diagnostic.terminalEvent).toEqual({ observation: 'unavailable' });
    expect(diagnostic.candidateProjection).toMatchObject({ state: 'unknown', reason: 'terminal_snapshot_mismatch' });
  });
  it.each(['missing-start', 'no-terminal'] as const)('keeps pure projector observations for %s even when strict terminal attribution is unavailable', mode => {
    const f = candidateFixture();
    if (mode === 'missing-start') f.log.events[1]!.type = 'session.synthetic';
    else { f.log.events.pop(); f.log.watermark--; }
    const reason = mode === 'missing-start' ? 'execution_interval_lineage_missing' : 'no_execution_terminal';
    const state = mode === 'missing-start' ? 'unknown' : 'pending';
    const diagnostic = projectV2OwnedSessionDiagnostic(f, { ...expected, nativeInputId: null }, '2.1.4', () => ({ state, reason }));
    expect(diagnostic.terminalEvent).toEqual({ observation: 'unavailable' });
    expect(diagnostic.candidateProjection).toMatchObject({ state, reason, terminalPresent: mode === 'missing-start' });
  });
  it('refuses foreign or incomplete cuts before projecting any candidate', () => {
    for (const mode of ['foreign', 'watermark', 'duplicate'] as const) {
      const f = candidateFixture();
      if (mode === 'foreign') f.log.events[0]!.aggregateID = 'ses_FOREIGN';
      if (mode === 'watermark') f.log.watermark++;
      if (mode === 'duplicate') f.messages.data.push(f.messages.data[0]!);
      expect(() => projectV2OwnedSessionDiagnostic(f, { ...expected, nativeInputId: null }, '2.1.4', () => ({ state: 'failed', reason: 'session.execution.failed' }))).toThrow();
    }
  });
  it('drops arbitrary child reasons, fields, and attribution escalation at the parent boundary', () => {
    const diagnostic = projectV2OwnedSessionDiagnostic(candidateFixture(), { ...expected, nativeInputId: null }, '2.1.4', () => ({ state: 'unknown', reason: 'SECRET_looks_safe' }));
    expect(diagnostic.candidateProjection).toEqual({ observation: 'unavailable' });
    const projected = reprojectV2OwnedSessionDiagnostic({ ...diagnostic,
      terminalEvent: { source: 'exact_original_owned_native_event', terminalType: 'session.execution.failed', errorType: 'provider.auth', raw: 'SECRET' }, raw: 'SECRET' });
    expect(projected.terminalEvent).toEqual({ observation: 'unavailable' });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
  });
});
