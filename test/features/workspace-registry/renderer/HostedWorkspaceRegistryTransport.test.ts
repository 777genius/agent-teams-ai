import {
  HOSTED_WORKSPACE_REGISTRY_ROUTES,
  HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
} from '@features/workspace-registry/contracts';
import {
  createHostedWorkspaceRegistryTransport,
  HostedWorkspaceRegistryTransportError,
} from '@features/workspace-registry/renderer';
import { describe, expect, it, vi } from 'vitest';

const WORKSPACE_ID = `workspace_${'a'.repeat(32)}`;
const CSRF = 'a'.repeat(32);

function workspace() {
  return {
    workspaceId: WORKSPACE_ID,
    label: 'Workspace 1',
    registrationRevision: 1,
    mount: {
      bootId: 'boot_workspace_renderer',
      mountGeneration: 1,
      observedAt: 100,
      health: 'read-only',
      capabilities: ['git.status.read'],
    },
  };
}

function response(body: unknown, status = 200) {
  return { status, json: vi.fn(async () => body) };
}

function transport(fetch: ReturnType<typeof vi.fn>) {
  return createHostedWorkspaceRegistryTransport({
    fetch,
    getCsrfToken: () => CSRF,
  });
}

describe('hosted workspace registry renderer transport', () => {
  it('uses browser-only authenticated list/select requests and parses safe DTOs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
          kind: 'workspace-list',
          workspaces: [workspace()],
        })
      )
      .mockResolvedValueOnce(
        response({
          schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
          kind: 'workspace-selection',
          workspace: workspace(),
        })
      );
    const client = transport(fetch);

    await expect(client.list()).resolves.toMatchObject({
      kind: 'workspace-list',
      workspaces: [{ workspaceId: WORKSPACE_ID }],
    });
    await expect(client.select(WORKSPACE_ID as never)).resolves.toMatchObject({
      kind: 'workspace-selection',
      workspace: { workspaceId: WORKSPACE_ID },
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: expect.objectContaining({ 'x-agent-teams-csrf': CSRF }),
        body: JSON.stringify({ schemaVersion: 1 }),
        signal: expect.any(AbortSignal),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
      expect.objectContaining({
        body: JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE_ID }),
      })
    );
  });

  it('rejects malformed requests and private or malformed responses', async () => {
    const fetch = vi.fn(async () =>
      response({
        schemaVersion: 1,
        kind: 'workspace-list',
        workspaces: [],
        declaredRootHash: '/srv/private',
      })
    );
    const client = transport(fetch);

    await expect(client.select('/srv/private' as never)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(client.list()).rejects.toMatchObject({ code: 'response_invalid' });
  });

  it('maps denied selection and transport failures to bounded errors', async () => {
    const denied = transport(vi.fn(async () => response({}, 404)));
    await expect(denied.select(WORKSPACE_ID as never)).rejects.toMatchObject({
      code: 'not_found',
    });

    const unavailable = createHostedWorkspaceRegistryTransport({
      fetch: vi.fn(),
      getCsrfToken: () => null,
    });
    const error = await unavailable.list().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(HostedWorkspaceRegistryTransportError);
    expect(error).toMatchObject({ code: 'transport_unavailable' });
  });

  it('rejects a response that settles after cancellation or the hard deadline', async () => {
    vi.useFakeTimers();
    try {
      let settle!: (value: ReturnType<typeof response>) => void;
      const fetch = vi.fn(
        () =>
          new Promise<ReturnType<typeof response>>((resolve) => {
            settle = resolve;
          })
      );
      const client = createHostedWorkspaceRegistryTransport({
        fetch,
        getCsrfToken: () => CSRF,
        timeoutMs: 10,
      });
      const pending = client.list();
      const deadlineRejection = expect(pending).rejects.toMatchObject({
        code: 'transport_unavailable',
      });
      await vi.advanceTimersByTimeAsync(10);
      await deadlineRejection;
      settle(
        response({
          schemaVersion: 1,
          kind: 'workspace-list',
          workspaces: [workspace()],
        })
      );
      await vi.runAllTimersAsync();

      const caller = new AbortController();
      const cancelled = client.list(caller.signal);
      const cancellationRejection = expect(cancelled).rejects.toMatchObject({
        code: 'request_cancelled',
      });
      caller.abort();
      await cancellationRejection;
      settle(
        response({
          schemaVersion: 1,
          kind: 'workspace-list',
          workspaces: [workspace()],
        })
      );
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});
