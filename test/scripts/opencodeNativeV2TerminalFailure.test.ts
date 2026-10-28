import { describe, expect, it } from 'vitest';

import { projectV2TerminalFailure } from '../../scripts/e2e/opencode-diagnostics/v2-terminal-failure';
const expected = { sessionId: 'ses_TEST', nativeInputId: 'msg_TEST' };
function fixture() {
  const event = (seq: number, type: string, data: Record<string, unknown>) => ({ id: `evt_${seq}`, seq, type, aggregateID: expected.sessionId, data: { sessionID: expected.sessionId, ...data } });
  return { messages: { previous: null, next: null, data: [{ id: 'msg_TEST', type: 'user' }] }, log: { synced: true, watermark: 3, events: [
    event(0, 'session.execution.started', {}), event(1, 'session.inbox.delivered', { inboxID: 'msg_TEST' }), event(2, 'session.step.ended', { finish: 'length' }),
    event(3, 'session.execution.failed', { error: { type: 'ContextOverflowError', message: 'SECRET/path/token', code: 'context_length_exceeded', statusCode: 400 } }),
  ] } };
}
describe('exact original V2 terminal diagnostic', () => {
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
