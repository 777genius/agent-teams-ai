import { expect, it, vi } from 'vitest';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { createHostGroupChatsApi } from '../../../src/features/agent-backend/renderer/createHostGroupChatsApi';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';
import { pageGroupCatalog } from '../../../packages/legacy-agent-host/dist/group-chats/pageGroupCatalog.js';

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
  const first = f.router.request.mock.results[0];
  if (!first || first.type !== 'return') throw new Error('Missing original Host response');
  const response = await first.value;
  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(Buffer.byteLength(JSON.stringify(response.value))).toBeLessThanOrEqual(240 * 1024);
  }
  expect(f.legacy.list).not.toHaveBeenCalled();
});

it('rejects changed original catalog revision without publishing partial rows', async () => {
  const source = [...original];
  const f = fixture(source);
  let reads = 0;
  f.router.request.mockImplementation(async (_handle, input) => {
    if (reads++ > 0) source.pop();
    return { ok: true, value: pageGroupCatalog({
      rows: source, key: cursorKey, principalId: 'TEST-principal',
      binding: 'TEST-owner-binding',
      ...(input.payload && typeof input.payload === 'object' && 'cursor' in input.payload
        ? { cursor: input.payload.cursor as string } : {}),
    }) };
  });
  await expect(f.api.list({ teamName: key })).rejects.toThrow();
  expect(f.legacy.list).not.toHaveBeenCalled();
});

it('old single-array group replies remain accepted without new selection or mutation', async () => {
  const f = fixture(original.slice(0, 2));
  expect(await f.api.list({ teamName: key })).toEqual(original.slice(0, 2));
  expect(f.router.request).toHaveBeenCalledTimes(1);
});

it('refuses duplicate rows across pages and an incomplete terminal catalog', async () => {
  for (const fault of ['duplicate', 'incomplete'] as const) {
    const f = fixture();
    f.router.request.mockImplementation(async (_handle, input) => {
      const next = input.payload && typeof input.payload === 'object' && 'cursor' in input.payload
        ? input.payload.cursor as string : undefined;
      const page = pageGroupCatalog({
        rows: original, key: cursorKey, principalId: 'TEST-principal',
        binding: 'TEST-owner-binding',
        ...(next === undefined ? {} : { cursor: next }),
      });
      if (!Array.isArray(page) && page && typeof page === 'object') {
        if (fault === 'incomplete') {
          return { ok: true, value: { ...page, nextCursor: null } };
        }
        if (next !== undefined && 'groups' in page && Array.isArray(page.groups)) {
          return { ok: true, value: {
            ...page,
            groups: [{ ...page.groups[0] as object, id: original[0]!.id }, ...page.groups.slice(1)],
          } };
        }
      }
      return { ok: true, value: page };
    });
    await expect(f.api.list({ teamName: key })).rejects.toThrow(
      fault === 'duplicate' ? 'Duplicate Host group' : 'Incomplete Host group catalog'
    );
    expect(f.legacy.list).not.toHaveBeenCalled();
  }
});
