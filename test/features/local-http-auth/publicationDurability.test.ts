import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiProfileScope } from '../../../src/features/local-http-auth/main/infrastructure/authorityPaths';
import { performPublication } from '../../../src/features/local-http-auth/main/infrastructure/authorityPublicationWorkflow';
import { parsePublicationRequest } from '../../../src/features/local-http-auth/main/infrastructure/publicationHelperProtocol';

const io = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  order: [] as string[],
  failFlush: '',
}));
vi.mock('../../../src/main/utils/durableFileSync', () => ({
  syncDirectoryDurably: async (directory: string) => {
    io.order.push(`flush:${directory}`);
    if (directory === io.failFlush)
      throw Object.assign(new Error('strict storage failure'), { code: 'EIO' });
  },
}));
vi.mock('node:fs/promises', () => ({
  unlink: async (file: string) => {
    io.order.push(`unlink:${file}`);
    if (!io.files.delete(file))
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  },
}));
vi.mock(
  '../../../src/features/local-http-auth/main/infrastructure/privateFiles',
  () => ({
    privateDirectory: async (root: string) => `${root}/local-http-auth`,
    readPrivateJson: async (file: string) => {
      if (!io.files.has(file))
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return io.files.get(file);
    },
    writePrivateJson: async (file: string, value: unknown) => {
      io.order.push(`rename:${file}`);
      io.files.set(file, value);
    },
  }),
);
vi.mock(
  '../../../src/features/local-http-auth/main/infrastructure/discoveryReference',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../src/features/local-http-auth/main/infrastructure/discoveryReference')
    >()),
    writeManualDiscovery: async (root: string, value: unknown) => {
      io.order.push(`manual:${root}`);
      io.files.set(`${root}/team-control-api.json`, value);
    },
  }),
);
const root = '/private/profile';
function request() {
  return parsePublicationRequest({
    v: 1,
    id: randomUUID(),
    op: 'publish',
    root,
    rootMode: 'existing',
    authority: {
      schemaVersion: 1,
      service: 'api',
      profileScope: apiProfileScope(root),
      instanceId: randomUUID(),
      generation: randomUUID(),
      baseUrl: 'http://127.0.0.1:1234',
      token: 'x'.repeat(32),
    },
  });
}
beforeEach(() => {
  io.files.clear();
  io.order.length = 0;
  io.failFlush = '';
});
describe('helper-only strict publication durability', () => {
  it('flushes descriptor/reference/manual directories before success, and every owned unlink before removal result', async () => {
    const input = request();
    expect((await performPublication(input)).outcome).toBe('published');
    const directory = `${root}/local-http-auth`;
    const descriptor = `${directory}/api-${input.authority.instanceId}-${input.authority.generation}.json`;
    const reference = `${directory}/api-${input.authority.instanceId}.ref.json`;
    expect(io.order).toEqual([
      `rename:${descriptor}`,
      `flush:${directory}`,
      `rename:${reference}`,
      `flush:${directory}`,
      `manual:${root}`,
      `flush:${root}`,
    ]);
    io.order.length = 0;
    expect((await performPublication({ ...input, op: 'remove' })).outcome).toBe(
      'removed',
    );
    expect(io.order).toEqual([
      `unlink:${root}/team-control-api.json`,
      `flush:${root}`,
      `unlink:${reference}`,
      `flush:${directory}`,
      `unlink:${descriptor}`,
      `flush:${directory}`,
    ]);
  });
  it('retains an exactly committed generation when only manual directory flush fails', async () => {
    const input = request();
    await performPublication(input);
    const before = new Map(io.files);
    io.failFlush = root;
    io.order.length = 0;
    expect(await performPublication(input)).toMatchObject({
      outcome: 'retained',
      code: 'retained-discovery',
    });
    expect(io.files).toEqual(before);
    expect(io.order.some((value) => value.startsWith('unlink:'))).toBe(false);
  });
  it('never reports a new publication successful after descriptor-directory EIO and still attempts exact cleanup', async () => {
    const input = request();
    io.failFlush = `${root}/local-http-auth`;
    expect(await performPublication(input)).toMatchObject({
      outcome: 'failed',
      code: 'storage-failed',
    });
    expect(io.files.size).toBe(0);
    expect(io.order.filter((value) => value.startsWith('manual:'))).toEqual([]);
    expect(io.order.some((value) => value.startsWith('unlink:'))).toBe(true);
  });
  it('continues all owned cleanup after strict unlink flush failure and carries exact revocation evidence', async () => {
    const input = request();
    await performPublication(input);
    io.failFlush = root;
    io.order.length = 0;
    expect(await performPublication({ ...input, op: 'remove' })).toMatchObject({
      outcome: 'failed',
      hintAction: 'revoke-matching',
    });
    expect(io.files.size).toBe(0);
    expect(
      io.order.filter((value) => value.startsWith('unlink:')),
    ).toHaveLength(3);
  });
});
