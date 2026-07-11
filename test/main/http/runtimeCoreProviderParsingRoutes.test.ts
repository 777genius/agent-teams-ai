import { registerProjectRoutes } from '@main/http/projects';
import { registerSearchRoutes } from '@main/http/search';
import { registerSessionRoutes } from '@main/http/sessions';
import { registerSubagentRoutes } from '@main/http/subagents';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeCoreProviderJsonParsingServices } from '@features/runtime-core/main';
import type { HttpServices } from '@main/http';
import type { FastifyInstance } from 'fastify';

const PROJECT_ID = '-Users-test-project';
const SESSION_ID = 'session-1';
const SUBAGENT_ID = 'agent-1';

interface ProviderParsingFixture {
  services: RuntimeCoreProviderJsonParsingServices;
  scan: ReturnType<typeof vi.fn>;
  getSessionWithOptions: ReturnType<typeof vi.fn>;
  parseSession: ReturnType<typeof vi.fn>;
  resolveSubagents: ReturnType<typeof vi.fn>;
  buildSessionDetail: ReturnType<typeof vi.fn>;
  searchSessions: ReturnType<typeof vi.fn>;
  buildSubagentDetail: ReturnType<typeof vi.fn>;
}

function createProviderParsingFixture(source: string): ProviderParsingFixture {
  const scan = vi.fn(async () => [{ id: source }]);
  const getSessionWithOptions = vi.fn(async () => ({ id: SESSION_ID, source }));
  const parseSession = vi.fn(async () => ({
    messages: [{ type: 'assistant', source }],
    taskCalls: [],
  }));
  const resolveSubagents = vi.fn(async () => []);
  const buildSessionDetail = vi.fn((session: { source: string }) => ({
    source: session.source,
    chunks: [],
    processes: [],
  }));
  const searchSessions = vi.fn(async () => ({
    source,
    results: [],
    totalMatches: 0,
    sessionsSearched: 0,
    query: 'needle',
  }));
  const buildSubagentDetail = vi.fn(async () => ({ source, id: SUBAGENT_ID }));

  return {
    services: {
      projectScanner: {
        scan,
        scanWithWorktreeGrouping: vi.fn(async () => []),
        listWorktreeSessions: vi.fn(async () => []),
        listSessions: vi.fn(async () => []),
        listSessionsPaginated: vi.fn(async () => ({ sessions: [], nextCursor: null })),
        getFileSystemProvider: vi.fn(() => ({ type: 'local' })),
        getSessionWithOptions,
        getSession: vi.fn(async () => ({ id: SESSION_ID, source })),
        searchSessions,
        searchAllProjects: vi.fn(async () => ({
          source,
          results: [],
          totalMatches: 0,
          sessionsSearched: 0,
          query: 'needle',
        })),
        getProjectsDir: vi.fn(() => '/projects'),
      } as unknown as RuntimeCoreProviderJsonParsingServices['projectScanner'],
      sessionParser: {
        parseSession,
      } as unknown as RuntimeCoreProviderJsonParsingServices['sessionParser'],
      subagentResolver: {
        resolveSubagents,
      } as unknown as RuntimeCoreProviderJsonParsingServices['subagentResolver'],
      chunkBuilder: {
        buildSessionDetail,
        buildGroups: vi.fn(() => []),
        buildWaterfallData: vi.fn(() => ({})),
        buildSubagentDetail,
      } as unknown as RuntimeCoreProviderJsonParsingServices['chunkBuilder'],
      dataCache: {
        get: vi.fn(() => undefined),
        set: vi.fn(),
        getSubagent: vi.fn(() => undefined),
        setSubagent: vi.fn(),
      } as unknown as RuntimeCoreProviderJsonParsingServices['dataCache'],
    },
    scan,
    getSessionWithOptions,
    parseSession,
    resolveSubagents,
    buildSessionDetail,
    searchSessions,
    buildSubagentDetail,
  };
}

function createHttpServices(
  providerJsonParsing: RuntimeCoreProviderJsonParsingServices
): HttpServices {
  return {
    ...providerJsonParsing,
    updaterService: {} as HttpServices['updaterService'],
    sshConnectionManager: {} as HttpServices['sshConnectionManager'],
  };
}

function registerProviderParsingRoutes(app: FastifyInstance, services: HttpServices): void {
  registerProjectRoutes(app, services);
  registerSessionRoutes(app, services);
  registerSearchRoutes(app, services);
  registerSubagentRoutes(app, services);
}

describe('runtimeCore provider parsing HTTP route wiring', () => {
  it('routes JSON and JSONL parsing endpoints through runtimeCore when present', async () => {
    const legacy = createProviderParsingFixture('legacy');
    const runtimeCore = createProviderParsingFixture('runtime-core');
    const services = {
      ...createHttpServices(legacy.services),
      runtimeCore: {
        providerJsonParsing: runtimeCore.services,
      },
    } satisfies HttpServices;
    const app = Fastify();
    registerProviderParsingRoutes(app, services);
    await app.ready();

    try {
      const projects = await app.inject({ method: 'GET', url: '/api/projects' });
      const session = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`,
      });
      const search = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}/search?q=needle`,
      });
      const subagent = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/subagents/${SUBAGENT_ID}`,
      });

      expect(projects.json()).toEqual([{ id: 'runtime-core' }]);
      expect(session.json()).toMatchObject({ source: 'runtime-core' });
      expect(search.json()).toMatchObject({ source: 'runtime-core' });
      expect(subagent.json()).toMatchObject({ source: 'runtime-core' });
      expect(runtimeCore.scan).toHaveBeenCalledTimes(1);
      expect(runtimeCore.parseSession).toHaveBeenCalledWith(PROJECT_ID, SESSION_ID);
      expect(runtimeCore.searchSessions).toHaveBeenCalledWith(PROJECT_ID, 'needle', 50);
      expect(runtimeCore.buildSubagentDetail).toHaveBeenCalledWith(
        PROJECT_ID,
        SESSION_ID,
        SUBAGENT_ID,
        runtimeCore.services.sessionParser,
        runtimeCore.services.subagentResolver,
        expect.objectContaining({ type: 'local' }),
        '/projects'
      );
      expect(legacy.scan).not.toHaveBeenCalled();
      expect(legacy.parseSession).not.toHaveBeenCalled();
      expect(legacy.searchSessions).not.toHaveBeenCalled();
      expect(legacy.buildSubagentDetail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('falls back to legacy HttpServices provider parsing when runtimeCore is absent', async () => {
    const legacy = createProviderParsingFixture('legacy');
    const app = Fastify();
    registerProviderParsingRoutes(app, createHttpServices(legacy.services));
    await app.ready();

    try {
      const session = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`,
      });

      expect(session.json()).toMatchObject({ source: 'legacy' });
      expect(legacy.getSessionWithOptions).toHaveBeenCalledWith(PROJECT_ID, SESSION_ID, {
        metadataLevel: 'deep',
      });
      expect(legacy.parseSession).toHaveBeenCalledWith(PROJECT_ID, SESSION_ID);
      expect(legacy.resolveSubagents).toHaveBeenCalled();
      expect(legacy.buildSessionDetail).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
