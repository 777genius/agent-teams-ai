import { expect, it, vi } from 'vitest';
import { pageOwnerSnapshot } from '../../../packages/legacy-agent-host/src/team/pageOwnerSnapshot';
import { readHostPagedSnapshot } from '../../../src/features/agent-backend/core/application/readHostPagedSnapshot';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/core/application/TeamProductReadOrder';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';

const cursor = '1.' + 'a'.repeat(64);
const connection = { handle: { handleId: 'TEST-original-handle' } } as BackendConnectionSnapshot['bindings'][number];
function process(index: number) {
  return {
    id: 'TEST-process-' + index, pid: 1000 + index, label: 'TEST service',
    registeredAt: '2026-11-28T00:00:00.000Z',
    processRef: 'p1:TEST:' + index.toString(16).padStart(64, '0'),
    observation: 'metadata-stopped' as const, canTerminate: false,
    command: 'x'.repeat(4096),
  };
}
function rawPage(rows: ReturnType<typeof process>[], options: {
  total?: number; cursor?: string | null; revision?: string;
} = {}) {
  return {
    teamName: 'TEST-team',
    revision: options.revision ?? 'a'.repeat(64),
    feed: {
      streamId: '33333333-3333-4333-8333-333333333333', sequence: 0,
      cursor: '11111111-1111-4111-8111-111111111111',
    },
    members: [], tasks: [], messages: [],
    kanbanState: { teamName: 'TEST-team', tasks: {}, reviewers: [] },
    processes: rows,
    ...(options.total === undefined ? {} : { processTotal: options.total }),
    nextCursor: options.cursor ?? null,
  };
}
async function read(raw: ReturnType<typeof rawPage>[]) {
  const pages = raw.map(projectTeamSnapshot);
  const invoke = vi.fn(async (request: { payload: { cursor?: string } }) => ({
    ok: true as const,
    value: request.payload.cursor ? pages[1] : pages[0],
  }));
  const order = new TeamProductReadOrder();
  const backend = { invoke } as unknown as Pick<AgentBackendApi, 'invoke'>;
  const result = await readHostPagedSnapshot(backend, connection, () => true, order);
  return { result, invoke, order };
}

it('retains complete ordered process history across separately projected Host pages', async () => {
  const rows = [process(1), process(2), process(3)];
  const { result, invoke } = await read([
    rawPage(rows.slice(0, 2), { total: 3, cursor }),
    rawPage(rows.slice(2), { total: 3 }),
  ]);
  expect(result.data.processes).toEqual(rows);
  expect(result.data.processTotal).toBeUndefined();
  expect(result.data.nextCursor).toBeUndefined();
  expect(invoke).toHaveBeenCalledTimes(2);
  result.assertCurrent();
});

it('keeps empty and legacy no-processTotal snapshot behavior', async () => {
  expect((await read([rawPage([], { total: 0 })])).result.data.processes).toEqual([]);
  const original = process(8);
  const old = await read([rawPage([original])]);
  expect(old.result.data.processes).toEqual([original]);
  expect(old.result.data.processTotal).toBeUndefined();
});

it('rejects incomplete and cross-page duplicate process histories before publishing a snapshot', async () => {
  const missing = [
    rawPage([process(1)], { total: 2, cursor }),
    rawPage([], { total: 2 }),
  ];
  const duplicate = [
    rawPage([process(1)], { total: 2, cursor }),
    rawPage([process(1)], { total: 2 }),
  ];
  for (const [pages, reason] of [
    [missing, 'Incomplete Host process history'],
    [duplicate, 'Invalid Host process history'],
  ] as const) {
    const order = new TeamProductReadOrder();
    const projected = pages.map(projectTeamSnapshot);
    const backend = { invoke: vi.fn(async (request: { payload: { cursor?: string } }) => ({
      ok: true as const,
      value: request.payload.cursor ? projected[1] : projected[0],
    })) } as unknown as Pick<AgentBackendApi, 'invoke'>;
    await expect(readHostPagedSnapshot(backend, connection, () => true, order))
      .rejects.toThrow(reason);
    expect(order.position(connection.handle.handleId)).toBeUndefined();
  }
});

it('refuses a changed original process total, changed revision and malformed projected total', async () => {
  const first = rawPage([process(1)], { total: 2, cursor });
  for (const changed of [
    rawPage([process(2)], { total: 3 }),
    rawPage([process(2)], { total: 2, revision: 'b'.repeat(64) }),
  ]) {
    await expect(read([first, changed])).rejects.toThrow('Host team changed during paged read');
  }
  expect(() => projectTeamSnapshot({ ...first, processTotal: -1 }))
    .toThrow('Invalid Host process page');
  expect(() => projectTeamSnapshot({ ...first, processes: undefined }))
    .toThrow('Invalid Host process page');
});

it.each([128 * 1024, 384 * 1024])(
  'restores exact process history through real %i-byte Host pages and the Desktop projection',
  async (maxBytes) => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...process(index), command: '漢😀\u0001"\\'.repeat(500) + index,
    }));
    const source = rawPage(rows), before = JSON.stringify(source), sizes: number[] = [];
    const order = new TeamProductReadOrder(), accepted = vi.spyOn(order, 'acceptSnapshot');
    const invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
      expect(request.handle).toEqual(connection.handle);
      if (request.operation !== 'team.snapshot') throw new Error('Unexpected TEST operation');
      expect(accepted).not.toHaveBeenCalled();
      const raw = pageOwnerSnapshot({
        principalId: 'TEST-reader', key: 'TEST-page-key', snapshot: source, maxBytes,
        ...(request.payload.cursor === undefined ? {} : { cursor: request.payload.cursor }),
      });
      sizes.push(Buffer.byteLength(JSON.stringify(raw)));
      return { ok: true, value: projectTeamSnapshot(raw) };
    });
    const result = await readHostPagedSnapshot({ invoke }, connection, () => true, order);
    result.assertCurrent();
    expect(result.data.processes).toEqual(rows);
    expect(result.data.nextCursor).toBeUndefined();
    expect(result.data.processTotal).toBeUndefined();
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every((size) => size <= maxBytes)).toBe(true);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(connection.handle.handleId, result.data);
    expect(JSON.stringify(source)).toBe(before);
  },
);

it.each([1024, 1025])('enforces the whole-history limit for %i individually valid process rows', async (count) => {
  const rows = Array.from({ length: count }, (_, index) => ({
    ...process(index), command: 'TEST short retained command',
  }));
  const pages = [
    rawPage(rows.slice(0, 512), { total: count, cursor }),
    rawPage(rows.slice(512), { total: count }),
  ].map(projectTeamSnapshot);
  const order = new TeamProductReadOrder(), accepted = vi.spyOn(order, 'acceptSnapshot');
  const invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
    if (request.operation !== 'team.snapshot') throw new Error('Unexpected TEST operation');
    const value = request.payload.cursor === undefined ? pages[0] : pages[1];
    if (!value) throw new Error('Missing TEST page');
    return { ok: true, value };
  });
  const pending = readHostPagedSnapshot({ invoke }, connection, () => true, order);
  if (count > 1024) {
    await expect(pending).rejects.toThrow('Invalid Host process history');
    expect(accepted).not.toHaveBeenCalled();
  } else {
    const result = await pending;
    result.assertCurrent();
    expect(result.data.processes).toEqual(rows);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(connection.handle.handleId, result.data);
  }
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('preserves the legacy complete process array repeated on every page without a total', async () => {
  const rows = [process(8), process(9)];
  const { result, invoke } = await read([rawPage(rows, { cursor }), rawPage(rows)]);
  result.assertCurrent();
  expect(result.data.processes).toEqual(rows);
  expect(result.data.processTotal).toBeUndefined();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls[1]?.[0].payload).toEqual({ cursor });
});
