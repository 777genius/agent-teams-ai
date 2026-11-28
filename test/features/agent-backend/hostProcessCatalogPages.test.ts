// @vitest-environment node
import { expect, it, vi } from 'vitest';

import {
  readBackendProcessCatalog,
} from '../../../src/features/agent-backend/contracts/processes';
import { readHostProcessCatalog } from '../../../src/features/agent-backend/core/application/readHostProcessCatalog';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

import type { BackendProcess } from '../../../src/features/agent-backend/contracts/processes';

const request = {
  handle: { handleId: 'TEST-original-process-owner' },
  commandId: 'TEST-process-read',
  operation: 'process.list' as const,
  payload: {},
};
const cursor = '1.' + 'a'.repeat(64);
const row = (index: number): BackendProcess => ({
  id: `TEST-process-${index}`, pid: 1001 + index, label: `TEST process ${index}`,
  registeredAt: '2026-11-28T00:00:00.000Z',
  processRef: `p1:TEST-process-${index}:${'b'.repeat(64)}`,
  observation: 'same-live', canTerminate: true,
});
const page = (processes: BackendProcess[], nextCursor: string | null, total = 2) => ({
  kind: 'process-catalog-page' as const, processes, total, revision: 'c'.repeat(64), nextCursor,
});
function project(value: unknown): unknown {
  const projected = projectBackendResult(request, { ok: true, value: JSON.parse(JSON.stringify(value)) });
  if (!projected.ok) throw new Error('Unexpected TEST projection failure');
  return projected.value;
}

it.each([{ rows: [] }, { rows: [row(0)] }])('preserves a complete small or empty legacy process result %#', async ({ rows }) => {
  const invoke = vi.fn(async () => project(rows));
  const current = vi.fn(() => {});
  await expect(readHostProcessCatalog(invoke, current)).resolves.toEqual(rows);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith(undefined);
  expect(current).toHaveBeenCalledTimes(3);
});

it('projects only original public capabilities and pending Stop selections across a complete catalog', async () => {
  const live = row(0), pending = {
    ...row(1), canTerminate: false,
    pendingStop: { commandId: 'TEST-original-stop', originalProcessRef: row(1).processRef, native: 'unknown' as const },
  };
  const privateLive = { ...live, capturedNative: { auditToken: [1] } };
  const responses = [
    { ...page([privateLive], cursor), privateRoot: '/TEST-private-owner' },
    page([pending], null),
  ];
  const invoke = vi.fn(async (next?: string) => {
    const parsed = parseBackendOperation({ ...request, payload: next === undefined ? {} : { cursor: next } });
    expect(parsed.payload).toEqual(next === undefined ? {} : { cursor: next });
    return project(responses[next === undefined ? 0 : 1]);
  });
  const result = await readHostProcessCatalog(invoke, () => {});
  expect(result).toEqual([live, pending]);
  expect(JSON.stringify(result)).not.toContain('auditToken');
  expect(JSON.stringify(result)).not.toContain('TEST-private-owner');
  expect(invoke.mock.calls).toEqual([[undefined], [cursor]]);
});

it.each([
  null, '', '0.' + 'a'.repeat(64), '01.' + 'a'.repeat(64),
  '1.' + 'A'.repeat(64), '1.' + 'a'.repeat(63),
  cursor + '\n', cursor + '\r', cursor + '\r\n', ' ' + cursor, cursor + ' ',
])('rejects malformed process continuation input %# before transport admission', value => {
  expect(() => parseBackendOperation({ ...request, payload: { cursor: value } })).toThrow();
});

it('keeps the empty process request and allows only an original cursor field', () => {
  expect(parseBackendOperation({ ...request, payload: {} })).toEqual(request);
  expect(parseBackendOperation({ ...request, payload: { cursor } }).payload).toEqual({ cursor });
  expect(() => parseBackendOperation({ ...request, payload: { cursor, pid: 1001 } })).toThrow();
});

it.each([
  { kind: 'wrong' }, { total: 0 }, { total: 1025 }, { total: 1.5 }, { total: '2' },
  { processes: [] }, { processes: [row(0), row(0)] },
  { revision: 'c'.repeat(63) }, { revision: 'C'.repeat(64) }, { revision: 'c'.repeat(64) + '\n' },
  { nextCursor: undefined }, { nextCursor: cursor + '\n' },
  { processes: [{ ...row(0), observation: 'unknown' }] },
  { processes: [{ ...row(0), pendingStop: {
    commandId: 'TEST-original-stop', originalProcessRef: row(0).processRef, native: 'accepted',
  } }] },
])('refuses malformed process page or capability metadata %#', change => {
  expect(() => project({ ...page([row(0)], cursor), ...change })).toThrow();
});

it.each([
  ['revision', 'Changed Host process catalog'],
  ['total', 'Changed Host process catalog'],
  ['duplicate', 'Duplicate Host process'],
  ['cursor', 'Repeated Host process cursor'],
  ['mixed', 'Mixed Host process pages'],
  ['incomplete', 'Incomplete Host process catalog'],
  ['overflow', 'Invalid Host process page length'],
  ['empty', 'Invalid process catalog page'],
  ['scope', 'TEST process scope changed'],
  ['rejected-scope', 'TEST process scope changed'],
] as const)('rejects %s continuation without returning a partial process inventory', async (mode, error) => {
  let current = true;
  const total = mode === 'cursor' || mode === 'incomplete' ? 3 : 2;
  const first = page([row(0)], cursor, total), second = page([row(1)], null, total);
  if (mode === 'revision') second.revision = 'd'.repeat(64);
  if (mode === 'total') second.total = 3;
  if (mode === 'duplicate') second.processes = [row(0)];
  if (mode === 'cursor') second.nextCursor = cursor;
  if (mode === 'overflow') second.processes.push(row(2));
  if (mode === 'empty') second.processes = [];
  const invoke = vi.fn(async (next?: string) => {
    if (next === undefined) return project(first);
    if (mode === 'scope' || mode === 'rejected-scope') current = false;
    if (mode === 'rejected-scope') throw new Error('TEST original transport rejected');
    return project(mode === 'mixed' ? [row(1)] : second);
  });
  await expect(readHostProcessCatalog(invoke, () => {
    if (!current) throw new Error('TEST process scope changed');
  })).rejects.toThrow(error);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('refuses nonterminal complete data before another request and bounds the entire public inventory', async () => {
  const invoke = vi.fn(async () => project(page([row(0)], cursor, 1)));
  await expect(readHostProcessCatalog(invoke, () => {})).rejects.toThrow('Invalid Host process continuation');
  expect(invoke).toHaveBeenCalledOnce();
  expect(() => readBackendProcessCatalog(Array.from({ length: 1025 }, (_, index) => row(index)))).toThrow();
});

it('stops a nonterminating original process continuation after exactly128 bounded requests', async () => {
  let index = 0;
  const invoke = vi.fn(async () => {
    const selected = index++;
    return project(page([row(selected)], (selected + 1) + '.' + 'a'.repeat(64), 1000));
  });
  await expect(readHostProcessCatalog(invoke, () => {})).rejects.toThrow('Host process catalog exceeded page limit');
  expect(invoke).toHaveBeenCalledTimes(128);
});

it('rejects revoked scope before the first request and before publishing even a complete legacy result', async () => {
  const invoke = vi.fn(async () => project([row(0)]));
  await expect(readHostProcessCatalog(invoke, () => { throw new Error('TEST revoked'); })).rejects.toThrow('TEST revoked');
  expect(invoke).not.toHaveBeenCalled();
  let checks = 0;
  await expect(readHostProcessCatalog(invoke, () => {
    if (++checks === 3) throw new Error('TEST revoked before publication');
  })).rejects.toThrow('TEST revoked before publication');
  expect(invoke).toHaveBeenCalledOnce();
});
