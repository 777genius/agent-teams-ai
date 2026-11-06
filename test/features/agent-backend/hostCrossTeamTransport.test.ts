import { expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import { createHostCrossTeamApi } from '../../../src/features/agent-backend/renderer/createHostCrossTeamApi';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';
import { remapHostCrossTeamMessages } from '../../../src/features/agent-backend/renderer/remapHostCrossTeamMessages';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { CrossTeamAPI } from '../../../src/shared/types/api';

const receipt = {
  kind: 'cross-team-receipt' as const,
  commandId: 'TEST-message',
  messageId: 'TEST-message',
  conversationId: 'TEST-original-conversation',
  toMember: 'lead',
  phase: 'completed' as const,
  deduplicated: false,
};
it('Main sends through the captured-pair router and preserves original lookup instead of another send', async () => {
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
    requestPair: vi.fn<BackendOwnerRouter['requestPair']>(),
  };
  router.requestPair.mockResolvedValue({ ok: true, value: receipt });
  const facade = new BackendOperationsFacade(router),
    handle = { handleId: 'TEST-source' },
    target = { handleId: 'TEST-target' };
  const request = {
    handle,
    commandId: 'TEST-message',
    operation: 'crossTeam.send',
    payload: { target, fromMember: 'user', messageId: 'TEST-message', text: 'TEST text' },
  };
  expect(await facade.invoke(request)).toEqual({ ok: true, value: receipt });
  expect(router.requestPair).toHaveBeenCalledWith(
    handle,
    target,
    expect.objectContaining({ method: 'team.crossTeam.send', payload: request.payload })
  );
  expect(router.request).not.toHaveBeenCalled();
  expect(
    await facade.invoke({ ...request, payload: { ...request.payload, messageId: 'TEST-other' } })
  ).toMatchObject({ ok: false, outcome: 'not-dispatched' });
  expect(
    await facade.invoke({
      ...request,
      payload: { ...request.payload, targetBinding: { teamId: 'TEST-forged' } },
    })
  ).toMatchObject({ ok: false, outcome: 'not-dispatched' });
  expect(router.requestPair).toHaveBeenCalledTimes(1);
  router.request.mockResolvedValue({
    ok: true,
    value: {
      kind: 'cross-team-lookup',
      commandId: 'TEST-message',
      phase: 'prepared',
      messageId: 'TEST-message',
      conversationId: receipt.conversationId,
      toMember: 'lead',
    },
  });
  expect(
    await facade.invoke({
      handle,
      commandId: 'TEST-message',
      operation: 'crossTeam.lookup',
      payload: {},
    })
  ).toMatchObject({ ok: true, value: { phase: 'prepared' } });
  expect(router.request).toHaveBeenCalledWith(
    handle,
    expect.objectContaining({
      method: 'team.crossTeam.lookup',
      commandId: 'TEST-message',
      payload: {},
      control: true,
    })
  );
});

function fixture() {
  const bindings = ['source.with.dot', 'target', 'foreign'].map((id, index) => ({
    handle: { handleId: id },
    label: index === 0 ? 'Alpha' : index === 1 ? 'Beta' : 'Foreign',
    members: [],
    ownerResourceRef: index === 2 ? 'TEST-other-owner' : 'TEST-owner',
    teamResourceRef: `TEST-scope-${id}`,
  }));
  const snapshot = (name: string): BackendTeamSnapshot => ({
    teamName: name,
    revision: 'a'.repeat(64),
    feed: { streamId: 'TEST-stream', sequence: 0, cursor: 'TEST-cursor' },
    members: [{ name: 'lead', role: 'lead' }],
    tasks: [],
    messages: [],
    kanbanState: { teamName: name, reviewers: [], tasks: {} },
  });
  const invoke = vi
    .fn<AgentBackendApi['invoke']>()
    .mockImplementation(async (request) => ({
      ok: true,
      value:
        request.operation === 'team.snapshot'
          ? snapshot(request.handle.handleId === 'target' ? 'beta' : 'alpha')
          : receipt,
    }));
  const backend: AgentBackendApi = {
    invoke,
    getConnections: vi.fn().mockResolvedValue({ state: 'ready', bindings }),
  };
  const legacy: CrossTeamAPI = {
    send: vi.fn(),
    listTargets: vi.fn().mockResolvedValue([]),
    getOutbox: vi.fn().mockResolvedValue([]),
  };
  let current = true;
  return {
    bindings,
    backend,
    invoke,
    legacy,
    api: createHostCrossTeamApi(legacy, backend, () => () => current),
    revoke() {
      current = false;
    },
  };
}
it('existing CrossTeam API lists same-owner Teams and refuses mixed/foreign ownership without legacy fallback', async () => {
  const f = fixture(),
    source = hostTeamSelectionKey('source.with.dot'),
    target = hostTeamSelectionKey('target');
  expect((await f.api.listTargets(source)).map((row) => row.teamName)).toEqual([target]);
  const request = {
    fromTeam: source,
    toTeam: target,
    fromMember: 'user',
    text: 'TEST text',
    messageId: 'TEST-message',
  };
  expect(await f.api.send(request)).toMatchObject({
    messageId: 'TEST-message',
    deliveredToInbox: true,
  });
  expect(f.invoke).toHaveBeenLastCalledWith(
    expect.objectContaining({
      operation: 'crossTeam.send',
      payload: expect.not.objectContaining({ conversationId: expect.anything() }),
    })
  );
  await expect(f.api.send({ ...request, toTeam: 'legacy-team' })).rejects.toThrow();
  await expect(
    f.api.send({ ...request, toTeam: hostTeamSelectionKey('foreign') })
  ).rejects.toThrow();
  expect(f.legacy.send).not.toHaveBeenCalled();
  await f.api.listTargets('legacy-team');
  expect(f.legacy.listTargets).toHaveBeenCalledWith('legacy-team');
  f.revoke();
  await expect(f.api.send(request)).rejects.toThrow();
  expect(
    f.invoke.mock.calls.filter(([request]) => request.operation === 'crossTeam.send')
  ).toHaveLength(1);
});

it('projects only finite cross-Team origin and maps existing opaque navigation without parsing handles as display names', () => {
  const f = fixture(),
    origin = {
      fromTeamName: 'alpha',
      toTeamName: 'beta',
      fromTeamResourceRef: 'TEST-scope-source.with.dot',
      toTeamResourceRef: 'TEST-scope-target',
    };
  const snapshot = projectTeamSnapshot({
    teamName: 'beta',
    revision: 'a'.repeat(64),
    feed: {
      streamId: '33333333-3333-4333-8333-333333333333',
      sequence: 0,
      cursor: '11111111-1111-4111-8111-111111111111',
    },
    members: [],
    tasks: [],
    kanbanState: { teamName: 'beta', reviewers: [], tasks: {} },
    messages: [
      {
        from: 'alpha.lead',
        to: 'lead',
        text: 'TEST cross',
        timestamp: 'TEST-time',
        read: false,
        source: 'cross_team',
        conversationId: 'TEST-conversation',
        crossTeamOrigin: { ...origin, principalId: 'PRIVATE' },
      },
    ],
  });
  expect(snapshot.messages[0]?.crossTeamOrigin).toEqual(origin);
  const mapped = remapHostCrossTeamMessages(
    snapshot.messages,
    'beta',
    hostTeamSelectionKey('target'),
    f.bindings
  );
  expect(mapped[0]).toMatchObject({
    from: 'alpha.lead',
    source: 'cross_team',
    conversationId: 'TEST-conversation',
    crossTeamNavigation: {
      fromTeamKey: hostTeamSelectionKey('source.with.dot'),
      toTeamKey: hostTeamSelectionKey('target'),
    },
  });
  expect(
    remapHostCrossTeamMessages(snapshot.messages, 'beta', hostTeamSelectionKey('target'), [])[0]
      ?.crossTeamNavigation?.fromTeamKey
  ).toBeUndefined();
});
