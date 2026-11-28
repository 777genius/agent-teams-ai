import { expect, it, vi } from 'vitest';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { createHostGroupChatsApi } from '../../../src/features/agent-backend/renderer/createHostGroupChatsApi';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/createHostTeamRouting';
import { pageGroupCatalog } from '../../../packages/legacy-agent-host/src/group-chats/pageGroupCatalog';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { TeamGroupChatsAPI } from '../../../src/features/team-group-chats/contracts';

const key = hostTeamSelectionKey('TEST-group-handle');
const cursorKey = 'TEST-Desktop-original-private-key';
const original = Array.from({ length: 4000 }, (_, index) => ({
  id: index.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000001',
  name: 'TEST group ' + index + ' ' + 'x'.repeat(75),
  createdAt: '2026-11-28T00:00:00.000Z',
  membership: { kind: 'fixed' as const, memberNames: ['alice', 'bob'] },
  archivedAt: index % 2 ? '2026-11-28T01:00:00.000Z' : null,
  memberNames: ['alice', 'bob'],
  availableRecipientNames: ['bob'],
  canSend: true,
}));

function fixture(rows = original) {
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(async (_handle, input) => ({
      ok: true as const,
      value: pageGroupCatalog({
        rows,
        key: cursorKey,
        principalId: 'TEST-principal',
        binding: 'TEST-owner-binding',
        ...(input.payload && typeof input.payload === 'object' && 'cursor' in input.payload
          ? { cursor: input.payload.cursor as string } : {}),
      }),
    })),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  const facade = new BackendOperationsFacade(router);
  const backend = {
    getConnections: vi.fn(async () => ({
      state: 'ready' as const,
      bindings: [{ handle: { handleId: 'TEST-group-handle' }, label: 'TEST', members: [] }],
    })),
    invoke: vi.fn<AgentBackendApi['invoke']>(request => facade.invoke(request)),
  } as unknown as AgentBackendApi;
  const legacy = { list: vi.fn() } as unknown as TeamGroupChatsAPI;
  const api = createHostGroupChatsApi(legacy, backend, () => () => true);
  return { router, backend, legacy, api };
}

it('Main validates and Desktop assembles 4000 real-shape groups without a priority-overflow response', async () => {
  expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(1024 * 1024);
  const f = fixture();
  const rows = await f.api.list({ teamName: key });
  expect(rows).toEqual(original);
  expect(f.router.request.mock.calls.length).toBeGreaterThan(1);
  for (const [, request] of f.router.request.mock.calls) {
    expect(request.method).toBe('team.group.list');
    expect(request.control).toBe(true);
  }
  const first = f.router.request.mock.results[0]?.value;
  const response = await first;
  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(Buffer.byteLength(JSON.stringify(response.value))).toBeLessThanOrEqual(240 * 1024);
  }
  expect(f.legacy.list).not.toHaveBeenCalled();
});

it('rejects changed original catalog revision without publishing partial rows', async () => {
  const f = fixture([...original]);
  let reads = 0;
  f.router.request.mockImplementation(async (_handle, input) => {
    if (reads++ > 0) original.pop(); // only the TEST page source drifts during the read
    return { ok: true, value: pageGroupCatalog({
      rows: original, key: cursorKey, principalId: 'TEST-principal',
      binding: 'TEST-owner-binding',
      ...(input.payload && typeof input.payload === 'object' && 'cursor' in input.payload
        ? { cursor: input.payload.cursor as string } : {}),
    }) };
  });
  await expect(f.api.list({ teamName: key })).rejects.toThrow();
  expect(f.legacy.list).not.toHaveBeenCalled();
  original.push({
    id: (3999).toString(16).padStart(8, '0') + '-0000-4000-8000-000000000001',
    name: 'TEST group 3999 ' + 'x'.repeat(75),
    createdAt: '2026-11-28T00:00:00.000Z',
    membership: { kind: 'fixed', memberNames: ['alice', 'bob'] }, archivedAt: '2026-11-28T01:00:00.000Z',
    memberNames: ['alice', 'bob'], availableRecipientNames: ['bob'], canSend: true,
  });
});

it('old single-array group replies remain accepted without new selection or mutation', async () => {
  const f = fixture(original.slice(0, 2));
  expect(await f.api.list({ teamName: key })).toEqual(original.slice(0, 2));
  expect(f.router.request).toHaveBeenCalledTimes(1);
});
