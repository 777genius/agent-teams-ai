import { registerSessionRoutes } from '@main/http/sessions';
import { DataCache } from '@main/services/infrastructure/DataCache';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';
import type { Session, SessionDetail } from '@main/types';

const projectId = '-synthetic-test-sandbox';
const sessionId = 'session-a';
const cacheKey = `${projectId}/${sessionId}`;
const url = `/api/projects/${projectId}/sessions/${sessionId}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const cache = new DataCache();
  const reads: ReturnType<typeof deferred<string>>[] = [];
  const session: Session = {
    id: sessionId,
    projectId,
    projectPath: '/synthetic-test/sandbox',
    createdAt: 1,
    hasSubagents: false,
    messageCount: 1,
  };
  // Parser is the external build boundary here; the transport and cache are real.
  const services = {
    dataCache: cache,
    projectScanner: {
      getFileSystemProvider: () => ({ type: 'local' }),
      getSessionWithOptions: () => Promise.resolve({ ...session }),
    },
    sessionParser: {
      parseSession: async () => {
        const read = deferred<string>();
        reads.push(read);
        const text = await read.promise;
        return { taskCalls: [], messages: [{ text }] };
      },
    },
    subagentResolver: { resolveSubagents: () => Promise.resolve([]) },
    chunkBuilder: {
      buildSessionDetail: (metadata: Session, messages: { text: string }[]): SessionDetail => ({
        session: { ...metadata, firstMessage: messages[0].text },
        messages: [],
        chunks: [],
        processes: [],
        metrics: {
          durationMs: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          messageCount: 1,
        },
      }),
    },
  } as unknown as HttpServices;
  const app = Fastify();
  registerSessionRoutes(app, services);
  return { app, cache, reads };
}

describe('HTTP session detail cache fill races', () => {
  it('does not republish or cache a result invalidated during parsing', async () => {
    const { app, cache, reads } = fixture();
    await app.ready();
    try {
      const response = app.inject({ method: 'GET', url });
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      cache.invalidateSession(projectId, sessionId);
      reads[0].resolve('stale-before-invalidation');
      const result = await response;
      expect(result.statusCode).toBe(200);
      expect(result.json()).toBeNull();
      expect(cache.get(cacheKey)).toBeUndefined();
    } finally {
      for (const read of reads) read.resolve('cleanup');
      await app.close();
    }
  });

  it('keeps a completed bypass result cached after an older read finishes', async () => {
    const { app, cache, reads } = fixture();
    await app.ready();
    try {
      const older = app.inject({ method: 'GET', url });
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      const fresh = app.inject({ method: 'GET', url: `${url}?bypassCache=true` });
      await vi.waitFor(() => expect(reads).toHaveLength(2));
      reads[1].resolve('fresh');
      expect((await fresh).json().session.firstMessage).toBe('fresh');
      reads[0].resolve('older');
      expect((await older).json().session.firstMessage).toBe('older');
      expect(cache.get(cacheKey)?.session.firstMessage).toBe('fresh');
    } finally {
      for (const read of reads) read.resolve('cleanup');
      await app.close();
    }
  });
});
