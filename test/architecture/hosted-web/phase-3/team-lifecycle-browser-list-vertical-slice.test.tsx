import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import {
  createPhase2ReadAuthority,
  createPhase2ReadComposition,
  createPhase2ReadHost,
} from '@main/composition/hosted/phase2ReadComposition';
import { registerTeamRoutes } from '@main/http/teams';
import { HttpAPIClient } from '@renderer/api/httpClient';
import { TeamListView } from '@renderer/components/team/TeamListView';
import {
  createQueryContext,
  parseBootId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
const browserApi = vi.hoisted(() => ({ listTeamLifecycle: vi.fn() }));
vi.mock('@renderer/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/api')>()),
  api: browserApi,
  isElectronMode: () => false,
}));

const NOW_MS = Date.parse('2026-07-20T00:00:30.000Z');
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'8'.repeat(32)}`);

function identity(fill: string): TeamIdentityRecord {
  return parseTeamIdentityRecord({
    teamId: parseTeamId(`team_${fill.repeat(32)}`),
    state: 'active',
    legacyKey: `sandbox-team-${fill}`,
    directoryFingerprint: fill.repeat(64),
    workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 1 },
    adoptionIntentId: `adoption_${fill.repeat(32)}`,
    identityChecksum: fill.repeat(64),
    createdAt: '2026-07-20T00:00:00.000Z',
    activatedAt: '2026-07-20T00:00:10.000Z',
    tombstonedAt: null,
  });
}

function createSandboxHost() {
  const identities = [identity('a'), identity('b')];
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'sandbox-browser-list',
    workspaceId: WORKSPACE_ID,
    displayName: 'Sandbox browser list',
    registrationRevision: 1,
    declaredRootHash: '9'.repeat(64),
    enabled: true,
  });
  const runtime = createRuntimeInstanceContext({
    deploymentId: 'deployment_browser-list',
    bootId: 'boot_browser-list',
    claudeRoot: { kind: 'claude', reference: 'runtime://sandbox-claude' },
    appDataRoot: { kind: 'app-data', reference: 'runtime://sandbox-app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: 'runtime://sandbox-workspace' }],
    tempRoot: { kind: 'temp', reference: 'runtime://sandbox-temp' },
    logsRoot: { kind: 'logs', reference: 'runtime://sandbox-logs' },
  });
  const mountBinding = new WorkspaceMountBinding({
    registration,
    bootId: parseBootId('boot_browser-list'),
    mountGeneration: 1,
    declaredRootHash: registration.declaredRootHash,
    observedAt: NOW_MS,
    health: 'healthy',
    allowedOperations: [],
  });
  const authority = createPhase2ReadAuthority({
    actorId: 'actor_browser-list',
    authorizedScope: 'scope_team-lifecycle.read',
    mountBinding,
    runtimeInstance: runtime,
  });
  const gateway: TeamIdentityReadGateway = {
    listTeamIdentities: () => Promise.resolve(identities),
    getTeamIdentity: (teamId) =>
      Promise.resolve(identities.find((candidate) => candidate.teamId === teamId) ?? null),
  };
  let failReads = false;
  let contextSequence = 0;
  const composition = createPhase2ReadComposition({
    authority,
    teamIdentities: gateway,
    legacyData: {
      listTeams: () => {
        if (failReads) throw new Error('sandbox fixture unavailable');
        return Promise.resolve(
          identities.map((record) => ({ teamName: record.legacyKey, pendingCreate: false }))
        );
      },
      getTeamData: (teamName) =>
        Promise.resolve({ teamName, config: {}, warnings: [], isAlive: false }),
    },
    legacyRuntime: {
      getRuntimeState: (teamName) => Promise.resolve({ teamName, isAlive: false }),
      getAliveTeams: () => Promise.resolve([]),
    },
    nowMs: () => NOW_MS,
    pageSize: 1,
  });
  const host = createPhase2ReadHost(composition, (hostAuthority, signal) =>
    createQueryContext({
      actorId: hostAuthority.actorId,
      sessionId: 'session_browser-list',
      deploymentId: hostAuthority.deploymentId,
      bootId: hostAuthority.bootId,
      requestId: `request_browser-list-${++contextSequence}`,
      authorizedScope: hostAuthority.authorizedScope,
      deadlineAtMs: NOW_MS + 10_000,
      signal,
    })
  );
  return {
    host,
    fail() {
      failReads = true;
    },
  };
}

describe('hosted browser team lifecycle list vertical slice', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    browserApi.listTeamLifecycle.mockReset();
    vi.stubGlobal(
      'EventSource',
      class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener(): void {}
        close(): void {}
      }
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders two real Fastify/HttpAPIClient pages and shows a later typed failure', async () => {
    const sandbox = createSandboxHost();
    const app = Fastify();
    registerTeamRoutes(app, { phase2ReadHost: sandbox.host } as HttpServices);
    await app.ready();
    const routeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const response = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url: url.pathname,
        headers: { 'content-type': 'application/json' },
        payload: init?.body as string | undefined,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': response.headers['content-type'] ?? 'application/json' },
      });
    });
    vi.stubGlobal('fetch', routeFetch);
    const client = new HttpAPIClient('http://phase3.test');
    const read = vi.spyOn(client, 'listTeamLifecycle');
    let completedReads = 0;
    const observedClient = {
      async listTeamLifecycle(
        request: Parameters<HttpAPIClient['listTeamLifecycle']>[0]
      ): ReturnType<HttpAPIClient['listTeamLifecycle']> {
        const result = await client.listTeamLifecycle(request);
        completedReads += 1;
        return result;
      },
    };
    browserApi.listTeamLifecycle.mockImplementation(observedClient.listTeamLifecycle);
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<TeamListView />);
        await Promise.resolve();
      });
      await act(async () => {
        await vi.waitFor(() => expect(completedReads).toBe(2));
        await Promise.resolve();
      });
      expect(container.textContent).toContain('sandbox-team-a');
      expect(container.textContent).toContain('sandbox-team-b');
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls[0][0]).toMatchObject({ cursor: null, expectedRevision: null });
      expect(read.mock.calls[1][0].cursor).not.toBeNull();
      expect(read.mock.calls[1][0].expectedRevision).not.toBeNull();
      expect(routeFetch).toHaveBeenCalledTimes(2);

      sandbox.fail();
      const refresh = container.querySelector<HTMLButtonElement>(
        'button[aria-label="actions.refresh"]'
      );
      await act(async () => {
        refresh?.click();
        await vi.waitFor(() => expect(completedReads).toBe(3));
        await Promise.resolve();
      });
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.textContent).toContain('list.loadFailed');
      expect(container.textContent).not.toContain('list.empty.title');
    } finally {
      act(() => root.unmount());
      await app.close();
    }
  });
});
