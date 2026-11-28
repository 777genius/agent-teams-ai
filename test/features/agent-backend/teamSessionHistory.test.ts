// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { parseBackendTeamOperation } from '../../../src/features/agent-backend/main/adapters/input/teamOperationValues';
import { projectTeamSessionHistory } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSessionHistory';
import { createHostLogStatsApi } from '../../../src/features/agent-backend/renderer/createHostLogStatsApi';

import type { AgentBackendApi, BackendActivityEvent, BackendOperationResult } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSessionHistory } from '../../../src/features/agent-backend/contracts/sessionHistory';

const sessionId = 'host-session-' + 'a'.repeat(64);
const history: BackendTeamSessionHistory = {
  kind: 'team-session-history', revision: 'a'.repeat(64),
  sessions: [{ kind: 'host_session', id: sessionId, startedAt: 1000, window: { start: 1000, end: null },
    clock: 'qualified', members: 1, generations: 2, isOngoing: false, gaps: [] }],
};
const noEvent = (_raw: unknown): BackendActivityEvent => { throw new Error('Unexpected activity fact'); };
it('the existing operation accepts only opaque Host history selections and bounded continuations', () => {
  expect(parseBackendTeamOperation('team.activity.logs.read', { scope: 'sessions' })).toEqual({ scope: 'sessions' });
  expect(parseBackendTeamOperation('team.activity.logs.read', {
    scope: 'session', sessionId, stream: 'conversation', cursor: 'signed-owner-page',
  })).toEqual({ scope: 'session', sessionId, stream: 'conversation', cursor: 'signed-owner-page' });
  for (const payload of [
    { scope: 'sessions', memberName: 'lead' }, { scope: 'sessions', taskId: 'task' },
    { scope: 'session', sessionId: 'native-session', stream: 'activity' },
    { scope: 'session', sessionId, stream: 'activity', cursor: 'x'.repeat(2049) },
    { scope: 'session', sessionId, stream: 'other' },
    { scope: 'session', sessionId, stream: 'activity', projectPath: '/TEST/foreign' },
  ]) expect(() => parseBackendTeamOperation('team.activity.logs.read', payload)).toThrow();
});
it('Main refuses a fabricated task window or wrong selected history page', () => {
  expect(projectTeamSessionHistory(history, { scope: 'sessions' }, noEvent)).toEqual(history);
  expect(() => projectTeamSessionHistory({ ...history, sessions: [
    ...history.sessions, { ...history.sessions[0], id: 'host-session-' + 'b'.repeat(64), startedAt: null },
  ] }, { scope: 'sessions' }, noEvent)).toThrow();
  expect(() => projectTeamSessionHistory({ ...history, sessions: [
    { ...history.sessions[0], window: { start: 900, end: null } },
  ] }, { scope: 'sessions' }, noEvent)).toThrow();
  expect(() => projectTeamSessionHistory({
    kind: 'team-session-page', sessionId: 'host-session-' + 'b'.repeat(64), stream: 'conversation',
  }, { scope: 'session', sessionId, stream: 'conversation' }, noEvent)).toThrow();
});
it('session reads use the selected execution handle and the existing currentness fence', async () => {
  let current = true;
  const handle = { handleId: 'TEST-project-execution' };
  let release!: (value: BackendOperationResult) => void;
  const backend: AgentBackendApi = {
    getConnections: vi.fn(),
    invoke: vi.fn(async () => new Promise<BackendOperationResult>(resolve => { release = resolve; })),
  };
  const resolve = vi.fn(async (key: string, check: () => boolean) => {
    expect(key).toBe('host-team:TEST-project-execution');
    return { handle, assertCurrent: () => { if (!check()) throw new Error('original project selection changed'); } };
  });
  const api = createHostLogStatsApi({ backend, captureScope: () => () => current, resolve });
  const first = api.getHostTeamSessions('host-team:TEST-project-execution');
  await Promise.resolve();
  release({ ok: true, value: history });
  expect(await first).toEqual(history);
  expect(backend.invoke).toHaveBeenCalledWith(expect.objectContaining({ handle,
    operation: 'team.activity.logs.read', payload: { scope: 'sessions' } }));
  const next = api.getHostTeamSessionPage('host-team:TEST-project-execution', sessionId, 'conversation', 'original-page');
  await Promise.resolve();
  current = false;
  release({ ok: true, value: { kind: 'team-session-page', sessionId, stream: 'conversation',
    revision: 'a'.repeat(64), log: null, messages: [], gaps: [], nextCursor: null } });
  await expect(next).rejects.toThrow('original project selection changed');
});

it('input pages preserve original state and explicit unknown time without accepting invented author data', () => {
  const query = { scope: 'session', sessionId, stream: 'inputs' } as const;
  expect(parseBackendTeamOperation('team.activity.logs.read', query)).toEqual(query);
  const input = { messageId: 'host-input-' + 'b'.repeat(64), memberName: 'lead', observedAt: null,
    phase: 'terminal', text: 'Original human prompt', part: 0, parts: 1 };
  const page = { kind: 'team-session-page', sessionId, stream: 'inputs', revision: 'a'.repeat(64),
    log: null, messages: [input], gaps: [], nextCursor: null };
  expect(projectTeamSessionHistory(page, query, noEvent)).toEqual(page);
  for (const changed of [{ observedAt: '2026-01-01T00:00:00Z' }, { phase: 'guessed-complete' },
    { messageId: '/private/native/session' }]) {
    expect(() => projectTeamSessionHistory({ ...page, messages: [{ ...input, ...changed }] }, query, noEvent)).toThrow();
  }
});
