// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { pageOwnerSnapshot } from '../../../packages/legacy-agent-host/src/team/pageOwnerSnapshot';
import { readHostPagedSnapshot } from '../../../src/features/agent-backend/core/application/readHostPagedSnapshot';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/core/application/TeamProductReadOrder';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';

const teamName = 'TEST-process-pages';
const connection: BackendConnectionSnapshot['bindings'][number] = {
  handle: { handleId: 'TEST-process-owner' },
  label: 'TEST original owner',
  members: [],
};
function sourceSnapshot(count = 100) {
  return {
    teamName,
    revision: 'a'.repeat(64),
    feed: {
      streamId: '33333333-3333-4333-8333-333333333333',
      sequence: 0,
      cursor: '11111111-1111-4111-8111-111111111111',
    },
    members: [{ name: 'lead', role: 'lead' as const }],
    tasks: [{ id: 'TEST-task', subject: 'Original task', status: 'completed' as const }],
    messages: [{ from: 'lead', text: 'Original message', timestamp: '2026-11-27', read: false }],
    processes: Array.from({ length: count }, (_, index) => ({
      id: 'TEST-process-' + index,
      pid: 1000 + index,
      label: 'Original process ' + index,
      registeredAt: '2026-11-27T00:00:00.000Z',
      processRef: 'p1:TEST-' + index + ':' + index.toString(16).padStart(64, '0'),
      observation: 'metadata-stopped' as const,
      canTerminate: false,
      command: index.toString().padStart(4, '0') + 'x'.repeat(4092),
      ...(index === 0
        ? {
            pendingStop: {
              commandId: 'TEST-original-stop',
              originalProcessRef: 'p1:TEST-0:' + '0'.repeat(64),
              native: 'unknown' as const,
            },
          }
        : {}),
    })),
    kanbanState: {
      teamName,
      reviewers: ['lead'],
      tasks: {
        'TEST-task': { column: 'review' as const, movedAt: '2026-11-27', reviewer: 'lead' },
      },
      columnOrder: { review: ['TEST-task'] },
    },
  };
}

function fixture(
  options: {
    maxBytes?: number;
    afterPage?(order: TeamProductReadOrder, makeStale: () => void, index: number): void;
  } = {}
) {
  const source = sourceSnapshot();
  const order = new TeamProductReadOrder();
  const accept = vi.spyOn(order, 'acceptSnapshot');
  let current = true;
  let pages = 0;
  const maxBytes = options.maxBytes ?? 128 * 1024;
  const invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
    expect(request.operation).toBe('team.snapshot');
    if (request.operation !== 'team.snapshot') throw new Error('Unexpected fixture operation');
    expect(request.handle).toEqual(connection.handle);
    expect(accept).not.toHaveBeenCalled();
    const raw = pageOwnerSnapshot({
      principalId: 'human',
      key: 'TEST-process-page-key',
      snapshot: source,
      maxBytes,
      ...request.payload,
    });
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(maxBytes);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid fixture page');
    const value = projectTeamSnapshot(raw);
    options.afterPage?.(
      order,
      () => {
        current = false;
      },
      pages
    );
    pages++;
    return { ok: true, value };
  });
  return {
    source,
    order,
    accept,
    invoke,
    read: () => readHostPagedSnapshot({ invoke }, connection, () => current, order),
  };
}

it.each([128 * 1024, 384 * 1024])(
  'reconstructs exact retained processes through the actual %i-byte pager and Main projection',
  async (maxBytes) => {
    const f = fixture({ maxBytes });
    const original = JSON.stringify(f.source);
    const result = await f.read();
    expect(f.invoke.mock.calls.length).toBeGreaterThan(1);
    expect(result.data.processes).toEqual(f.source.processes);
    expect(result.data.messages).toEqual(f.source.messages);
    expect(result.data.kanbanState).toEqual(f.source.kanbanState);
    expect(result.data.tasks).toEqual([
      { ...f.source.tasks[0], kanbanColumn: 'review', reviewer: 'lead' },
    ]);
    expect(result.data.processTotal).toBeUndefined();
    expect(result.data.nextCursor).toBeUndefined();
    expect(f.accept).toHaveBeenCalledTimes(1);
    expect(f.accept).toHaveBeenCalledWith(connection.handle.handleId, result.data);
    expect(JSON.stringify(f.source)).toBe(original);
    result.assertCurrent();
  }
);

it.each(['scope', 'mutation'] as const)(
  'refuses a process continuation that crosses the original %s fence before publication',
  async (kind) => {
    const f = fixture({
      afterPage(order, makeStale, index) {
        if (index !== 1) return;
        if (kind === 'scope') makeStale();
        else order.invalidateReads(connection.handle.handleId);
      },
    });
    await expect(f.read()).rejects.toThrow(
      kind === 'scope' ? 'Team context changed' : 'Host read crossed a mutation boundary'
    );
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.order.position(connection.handle.handleId)).toBeUndefined();
  }
);
