import { expect, it } from 'vitest';

import { pageGroupCatalog } from '../../../packages/legacy-agent-host/src/group-chats/pageGroupCatalog';
import { readHostGroupCatalog } from '../../../src/features/agent-backend/core/application/readHostGroupCatalog';

const rows = Array.from({ length: 2000 }, (_, index) => ({
  id: index.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000001',
  name: 'TEST group ' + index + ' ' + 'x'.repeat(65),
  createdAt: '2026-11-28T00:00:00.000Z',
  membership: { kind: 'fixed' as const, memberNames: ['alice', 'bob'] },
  archivedAt: index % 2 ? '2026-11-28T01:00:00.000Z' : null,
  memberNames: ['alice', 'bob'],
  availableRecipientNames: ['bob'],
  canSend: true,
}));
const option = { key: 'TEST-private-native-page', principalId: 'TEST-owner', binding: 'TEST-bound-team' };

it('reconstructs all canonical group names beyond page one without partial publication', async () => {
  expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(240 * 1024);
  let calls = 0;
  const data = await readHostGroupCatalog(async cursor => {
    calls++;
    const page = pageGroupCatalog({ ...option, rows, ...(cursor ? { cursor } : {}) });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(240 * 1024);
    return JSON.parse(JSON.stringify(page)) as unknown;
  }, () => {});
  expect(calls).toBeGreaterThan(1);
  expect(data).toEqual(rows);
  expect(Object.fromEntries(data.map(group => [group.id, group.name]))[rows.at(-1)!.id])
    .toBe(rows.at(-1)!.name);
});

it('preserves legacy empty and small catalogs without adding a cursor', async () => {
  for (const list of [[], rows.slice(0, 2)]) {
    const calls: (string | undefined)[] = [];
    const result = await readHostGroupCatalog(async cursor => {
      calls.push(cursor);
      return pageGroupCatalog({ ...option, rows: list, ...(cursor ? { cursor } : {}) });
    }, () => {});
    expect(result).toEqual(list);
    expect(calls).toEqual([undefined]);
  }
});

it('refuses original revision changes and revocation after awaited continuation', async () => {
  const current = [...rows];
  let calls = 0;
  await expect(readHostGroupCatalog(async cursor => {
    if (calls++ > 0) current.pop();
    return pageGroupCatalog({ ...option, rows: current, ...(cursor ? { cursor } : {}) });
  }, () => {})).rejects.toThrow();
  let valid = true;
  const pending = readHostGroupCatalog(async cursor => {
    const page = pageGroupCatalog({ ...option, rows, ...(cursor ? { cursor } : {}) });
    valid = false;
    return page;
  }, () => { if (!valid) throw new Error('Original owner retired'); });
  await expect(pending).rejects.toThrow('Original owner retired');
});

it('rejects repeated, malformed and incomplete pages before returning group data', async () => {
  const first = pageGroupCatalog({ ...option, rows }) as {
    kind: 'group-catalog-page';
    groups: typeof rows;
    revision: string;
    total: number;
    nextCursor: string | null;
  };
  expect(first.kind).toBe('group-catalog-page');
  await expect(readHostGroupCatalog(async cursor => {
    if (!cursor) return first;
    const next = pageGroupCatalog({ ...option, rows, cursor });
    if (!next || typeof next !== 'object' || Array.isArray(next))
      throw new Error('Expected continued Host group page');
    return { ...next, nextCursor: cursor };
  }, () => {})).rejects.toThrow('Repeated Host group cursor');
  await expect(readHostGroupCatalog(async () => first, () => {}))
    .rejects.toThrow('Duplicate Host group');
  await expect(readHostGroupCatalog(async () => ({ ...first, nextCursor: null }), () => {}))
    .rejects.toThrow('Incomplete Host group catalog');
  await expect(readHostGroupCatalog(async () => ({ ...first, groups: [] }), () => {}))
    .rejects.toThrow();
});
