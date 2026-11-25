import { expect, it, vi } from 'vitest';

import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { createHostCrossTeamApi } from '../../../src/features/agent-backend/renderer/createHostCrossTeamApi';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { CrossTeamAPI } from '../../../src/shared/types/api';

const key = hostTeamSelectionKey;
function fixture() {
  const binding = (id: string): BackendConnectionSnapshot['bindings'][number] => ({
    handle: { handleId: id }, label: id, ownerResourceRef: 'TEST-owner',
    teamResourceRef: 'TEST-team-' + id, members: [],
  });
  const root = { ...binding('source-logical'), projectContextMode: 'per_project' as const };
  const source = { ...binding('source-child'), projectContext: {
    logicalHandleId: root.handle.handleId, projectPath: '/TEST/project-a', workContextId: 'TEST-source-context' } };
  const target = { ...binding('target-logical'), projectContextMode: 'per_project' as const };
  const child = { ...binding('target-child'), projectContext: {
    logicalHandleId: target.handle.handleId, projectPath: '/TEST/project-a', workContextId: 'TEST-target-context' } };
  const rows = [root, source, target, child];
  let ready = true, failSend = false;
  const invoke = vi.fn<AgentBackendApi['invoke']>(async request => {
    if (request.operation === 'team.project-context.read') return { ok: true, value: {
      kind: 'team-project-context', histories: [], view: ready ? {
        mode: 'per_project', state: 'ready', executionTeamName: key(child.handle.handleId),
        projectPath: child.projectContext.projectPath, workContextId: child.projectContext.workContextId,
      } : { mode: 'per_project', state: 'empty' },
    } };
    if (request.operation === 'team.snapshot') return { ok: true, value: {
      teamName: request.handle.handleId, revision: 'a'.repeat(64),
      feed: { streamId: 'TEST-' + request.handle.handleId, sequence: 0, cursor: 'TEST-cursor' },
      members: [{ name: 'lead', role: 'lead' }], tasks: [], messages: [],
      kanbanState: { teamName: request.handle.handleId, tasks: {}, reviewers: [] },
    } };
    if (request.operation === 'crossTeam.send') {
      if (failSend) { failSend = false; throw new Error('TEST lost acknowledgement'); }
      return { ok: true, value: { kind: 'cross-team-receipt', commandId: request.commandId,
        messageId: request.commandId, conversationId: 'TEST-conversation', toMember: 'lead',
        phase: 'completed', deduplicated: false } };
    }
    throw new Error('Unexpected TEST operation ' + request.operation);
  });
  const getConnections = vi.fn<AgentBackendApi['getConnections']>(async () => ({ state: 'ready', bindings: rows }));
  const legacy: CrossTeamAPI = { send: vi.fn(), listTargets: vi.fn(), getOutbox: vi.fn() };
  const api = createHostCrossTeamApi(legacy, { invoke, getConnections }, () => () => true);
  const request = { fromTeam: key(source.handle.handleId), fromMember: 'user',
    toTeam: key(target.handle.handleId), messageId: 'TEST-message', text: 'TEST original input' };
  return { api, legacy, invoke, getConnections, root, source, target, child, rows, request,
    empty: () => { ready = false; }, loseAck: () => { failSend = true; } };
}

it('lists logical destinations and captures the existing same-project execution child', async () => {
  const f = fixture();
  expect((await f.api.listTargets(f.request.fromTeam)).map(row => row.teamName))
    .toEqual([key(f.target.handle.handleId)]);
  await f.api.send(f.request);
  expect(f.invoke).toHaveBeenLastCalledWith(expect.objectContaining({ handle: f.source.handle,
    operation: 'crossTeam.send', payload: expect.objectContaining({ target: f.child.handle }) }));
  expect(f.legacy.send).not.toHaveBeenCalled();
});

it('does not create a destination project context while sending', async () => {
  const f = fixture();
  f.empty();
  await expect(f.api.send(f.request)).rejects.toThrow();
  expect(f.invoke.mock.calls.some(([r]) => r.operation === 'crossTeam.send' || r.operation === 'team.project-context.prepare'))
    .toBe(false);
});

it('rejects a foreign execution child even when the public project view points at it', async () => {
  const f = fixture();
  f.child.ownerResourceRef = 'TEST-foreign-owner';
  await expect(f.api.send(f.request)).rejects.toThrow();
  expect(f.invoke.mock.calls.some(([r]) => r.operation === 'crossTeam.send')).toBe(false);
});

it('refuses logical senders and messages within one logical family', async () => {
  const f = fixture();
  await expect(f.api.send({ ...f.request, fromTeam: key(f.root.handle.handleId) })).rejects.toThrow();
  f.child.projectContext.logicalHandleId = f.root.handle.handleId;
  await expect(f.api.send({ ...f.request, messageId: 'TEST-same-family', toTeam: key(f.child.handle.handleId) }))
    .rejects.toThrow();
});

it('retries the exact captured pair after lost acknowledgement without resolving a newer project', async () => {
  const f = fixture();
  f.loseAck();
  await expect(f.api.send(f.request)).rejects.toThrow();
  const original = structuredClone(f.invoke.mock.calls.filter(([r]) => r.operation === 'crossTeam.send')[0][0]);
  f.empty();
  await f.api.send(f.request);
  const sends = f.invoke.mock.calls.filter(([r]) => r.operation === 'crossTeam.send');
  expect(sends.map(([r]) => r)).toEqual([original, original]);
  expect(f.getConnections).toHaveBeenCalledOnce();
});

it('reserves command identity before an awaited catalog and shares the original concurrent capture', async () => {
  const f = fixture();
  let release!: (value: BackendConnectionSnapshot) => void;
  f.getConnections.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = f.api.send(f.request);
  const retry = f.api.send(structuredClone(f.request));
  await expect(f.api.send({ ...f.request, text: 'TEST substituted input' })).rejects.toThrow();
  await Promise.resolve();
  release({ state: 'ready', bindings: f.rows });
  await Promise.all([first, retry]);
  expect(f.getConnections).toHaveBeenCalledOnce();
  expect(f.invoke.mock.calls.filter(([r]) => r.operation === 'team.project-context.read')).toHaveLength(1);
  const sends = f.invoke.mock.calls.filter(([r]) => r.operation === 'crossTeam.send');
  expect(sends).toHaveLength(2);
  expect(sends[0][0]).toEqual(sends[1][0]);
});
