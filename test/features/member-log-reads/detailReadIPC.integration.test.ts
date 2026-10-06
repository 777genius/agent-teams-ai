import {
  initializeSessionHandlers,
  registerSessionHandlers,
  removeSessionHandlers,
} from '@main/ipc/sessions';
import { initializeSubagentHandlers, registerSubagentHandlers } from '@main/ipc/subagents';
import { ServiceContext } from '@main/services/infrastructure/ServiceContext';
import { ServiceContextRegistry } from '@main/services/infrastructure/ServiceContextRegistry';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  FileSystemProvider,
  ReadStreamOptions,
} from '@main/services/infrastructure/FileSystemProvider';
import type { SessionDetail, SubagentDetail } from '@main/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

// The updater is an unrelated Electron OS adapter pulled by the predecessor's broad barrel.
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }));

const project = '-synthetic-test-sandbox';
const session = 'session-a';
const roots: ServiceContext[] = [];
const streams: PassThrough[] = [];
const pendingReads: Promise<unknown>[] = [];

function jsonl(uuid: string): string {
  return `${JSON.stringify({
    uuid,
    type: 'user',
    parentUuid: null,
    timestamp: '2026-10-07T00:00:00Z',
    cwd: '/synthetic-test/sandbox',
    sessionId: session,
    message: { role: 'user', content: `observable-${uuid}` },
  })}\n`;
}

function fixture(id = 'local') {
  const reads: PassThrough[] = [];
  let filesystemCalls = 0;
  // Only the external filesystem is replaced. Scanner/parser/builder/cache/lifecycle are real.
  const provider: FileSystemProvider = {
    type: 'ssh',
    exists: (path) => {
      filesystemCalls++;
      return Promise.resolve(
        path.endsWith(`${session}.jsonl`) ||
          path.endsWith('/subagents/agent-worker-a.jsonl') ||
          path === '/synthetic-test/projects' ||
          path === `/synthetic-test/projects/${project}`
      );
    },
    readFile: () => Promise.resolve(jsonl('metadata')),
    stat: () =>
      Promise.resolve({
        size: 500,
        mtimeMs: 1,
        birthtimeMs: 1,
        isFile: () => true,
        isDirectory: () => false,
      }),
    readdir: () => Promise.resolve([]),
    createReadStream: (_path: string, options?: ReadStreamOptions): Readable => {
      if (options?.encoding) return Readable.from([jsonl('metadata')]);
      const stream = new PassThrough();
      reads.push(stream);
      streams.push(stream);
      return stream;
    },
    dispose() {
      // This in-memory provider owns no persistent filesystem resources.
    },
  };
  const context = new ServiceContext({
    id,
    type: id === 'local' ? 'local' : 'ssh',
    fsProvider: provider,
    projectsDir: '/synthetic-test/projects',
    todosDir: '/synthetic-test/todos',
  });
  roots.push(context);
  return { context, reads, filesystemCalls: () => filesystemCalls };
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function transport(registry: ServiceContextRegistry) {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  initializeSessionHandlers(registry);
  initializeSubagentHandlers(registry);
  registerSessionHandlers(ipc);
  registerSubagentHandlers(ipc);
  const read = (options?: unknown): Promise<SessionDetail | null> => {
    const promise = handlers.get('get-session-detail')!(
      {} as IpcMainInvokeEvent,
      ` ${project} `,
      ` ${session} `,
      options
    ) as Promise<SessionDetail | null>;
    pendingReads.push(promise);
    return promise;
  };
  const readSubagent = (options?: unknown): Promise<SubagentDetail | null> => {
    const promise = handlers.get('get-subagent-detail')!(
      {} as IpcMainInvokeEvent,
      ` ${project} `,
      ` ${session} `,
      ' worker-a ',
      options
    ) as Promise<SubagentDetail | null>;
    pendingReads.push(promise);
    return promise;
  };
  return { ipc, read, readSubagent };
}

afterEach(async () => {
  for (const context of roots.splice(0)) {
    if (!context.isDisposed()) context.dispose();
  }
  for (const stream of streams.splice(0)) if (!stream.writableEnded) stream.end();
  await Promise.allSettled(pendingReads.splice(0));
});

describe('registered IPC detail read ownership', () => {
  // Red if duplicate IPC calls parse twice, fresh callers receive the old read,
  // or a retired context/adapter publishes into its replacement.
  it('coalesces equivalent normalized requests using the actual parser and cache', async () => {
    const { context, reads } = fixture();
    const registry = new ServiceContextRegistry();
    registry.registerContext(context);
    const { read } = transport(registry);
    const a = read();
    const b = read();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads[0].end(jsonl('shared'));
    const [first, second] = await Promise.all([a, b]);
    expect(first?.messages.map((message) => message.uuid)).toEqual(['shared']);
    expect(second).toBe(first);
    expect(context.dataCache.get(`${project}/${session}`)).toBe(first);
    expect(await read()).toBe(first);
    expect(reads).toHaveLength(1);
  });

  it('gives all fresh callers one successor after the active physical read settles', async () => {
    const { context, reads } = fixture();
    const registry = new ServiceContextRegistry();
    registry.registerContext(context);
    const { read } = transport(registry);
    const old = read();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    const freshA = read({ bypassCache: true });
    const freshB = read({ bypassCache: true });
    await Promise.resolve();
    expect(reads).toHaveLength(1);
    reads[0].end(jsonl('old'));
    expect((await old)?.messages.map((message) => message.uuid)).toEqual(['old']);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(context.dataCache.get(`${project}/${session}`)).toBeUndefined();
    reads[1].end(jsonl('fresh'));
    const [a, b] = await Promise.all([freshA, freshB]);
    expect(a?.messages.map((message) => message.uuid)).toEqual(['fresh']);
    expect(b).toBe(a);
    expect(context.dataCache.get(`${project}/${session}`)).toBe(a);
    expect(reads).toHaveLength(2);
  });

  it('retains the physical slot across switch-away and switch-back', async () => {
    const { context, reads } = fixture();
    const other = fixture('synthetic-ssh');
    const registry = new ServiceContextRegistry();
    registry.registerContext(context);
    registry.registerContext(other.context);
    const { read } = transport(registry);
    const old = read();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    registry.switch(other.context.id);
    registry.switch(context.id);
    expect(await old).toBeNull();
    const current = read();
    await Promise.resolve();
    expect(reads).toHaveLength(1);
    reads[0].end(jsonl('retired'));
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1].end(jsonl('current'));
    const detail = await current;
    expect(detail?.messages.map((message) => message.uuid)).toEqual(['current']);
    expect(context.dataCache.get(`${project}/${session}`)).toBe(detail);
  });

  it('does not publish from a replaced context with the same ID', async () => {
    const first = fixture();
    const replacement = fixture();
    const registry = new ServiceContextRegistry();
    registry.registerContext(first.context);
    const { read } = transport(registry);
    const old = read();
    await vi.waitFor(() => expect(first.reads).toHaveLength(1));
    registry.replaceContext('local', replacement.context);
    expect(await old).toBeNull();
    const current = read();
    await vi.waitFor(() => expect(replacement.reads).toHaveLength(1));
    first.reads[0].end(jsonl('retired'));
    replacement.reads[0].end(jsonl('replacement'));
    expect((await current)?.messages.map((message) => message.uuid)).toEqual(['replacement']);
    expect(first.context.dataCache.isEnabled()).toBe(false);
  });

  it('retires removed adapters without starting a second physical read', async () => {
    const { context, reads } = fixture();
    const registry = new ServiceContextRegistry();
    registry.registerContext(context);
    const first = transport(registry);
    const old = first.read();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    removeSessionHandlers(first.ipc);
    expect(await old).toBeNull();
    const second = transport(registry);
    const current = second.read();
    await Promise.resolve();
    expect(reads).toHaveLength(1);
    reads[0].end(jsonl('removed-adapter'));
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1].end(jsonl('new-adapter'));
    expect((await current)?.messages.map((message) => message.uuid)).toEqual(['new-adapter']);
  });

  it('coalesces actual subagent builders and preserves a distinct fresh successor', async () => {
    const { context, reads } = fixture();
    const registry = new ServiceContextRegistry();
    registry.registerContext(context);
    const { readSubagent } = transport(registry);
    const oldA = readSubagent();
    const oldB = readSubagent();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    const freshA = readSubagent({ bypassCache: true });
    const freshB = readSubagent({ bypassCache: true });
    expect(reads).toHaveLength(1);
    reads[0].end(jsonl('old-subagent'));
    const [oldFirst, oldSecond] = await Promise.all([oldA, oldB]);
    expect(oldFirst?.description).toBe('observable-old-subagent');
    expect(oldSecond).toBe(oldFirst);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1].end(jsonl('fresh-subagent'));
    const [first, second] = await Promise.all([freshA, freshB]);
    expect(first?.id).toBe('worker-a');
    expect(first?.description).toBe('observable-fresh-subagent');
    expect(second).toBe(first);
    expect(context.dataCache.getSubagent(`subagent-${project}-${session}-worker-a`)).toBe(first);
  });

  it.each([null, true, [], { bypassCache: 'true' }, { bypassCache: 1 }])(
    'rejects malformed options before filesystem work: %j',
    async (options) => {
      const { context, reads, filesystemCalls } = fixture();
      const registry = new ServiceContextRegistry();
      registry.registerContext(context);
      const { read } = transport(registry);
      expect(await read(options)).toBeNull();
      expect(reads).toHaveLength(0);
      expect(filesystemCalls()).toBe(0);
    }
  );
});
