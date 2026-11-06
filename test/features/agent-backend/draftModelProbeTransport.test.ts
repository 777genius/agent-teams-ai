// @vitest-environment node
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import {
  BackendOperationsFacade,
  registerAgentBackendHttp,
  registerAgentBackendIpc,
} from '../../../src/features/agent-backend/main';
import { createAgentBackendBridge } from '../../../src/features/agent-backend/preload';
import { createAgentBackendHttpClient } from '../../../src/features/agent-backend/renderer';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main';
import type { AgentBackendIpcPort } from '../../../src/features/agent-backend/preload';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const request: BackendOperationRequest = {
  handle: { handleId: 'TEST-original-team-owner' },
  commandId: 'TEST-original-draft-model-probe',
  operation: 'team.launch.probe.start',
  payload: {
    launchId: 'saved-model-TEST',
    rosterRevision: 'TEST-roster',
    memberId: 'draft:new-worker',
    model: '__provider_default__',
    effort: 'minimal',
    draft: {
      providerId: 'codex',
      target: { kind: 'member', name: 'new-worker' },
      workspace: '/TEST/desired-member-project',
    },
  },
};

it('preserves desired provider/workspace and the original model intent through actual Main IPC/HTTP validation and projection', async () => {
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  router.request.mockResolvedValue({
    ok: true,
    value: {
      ...request.payload,
      commandId: request.commandId,
      phase: 'completed',
      ok: true,
      expiresAt: Date.now() + 60000,
      privateRecipe: { executable: '/PRIVATE/cli', environment: { TOKEN: 'PRIVATE' } },
    },
  });
  const facade = new BackendOperationsFacade(router);
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<BackendOperationResult>;
  const ipc = {
    handle: vi.fn((_channel, callback) => {
      handler = callback;
    }),
    removeHandler: vi.fn(),
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
  const dispose = registerAgentBackendIpc(ipc, facade, () => true);
  const app = Fastify();
  registerAgentBackendHttp(app, facade, () => true);
  const bridge = createAgentBackendBridge({
    invoke: ((_channel: string, value: BackendOperationRequest) =>
      handler({} as IpcMainInvokeEvent, value)) as AgentBackendIpcPort['invoke'],
  });
  const http = createAgentBackendHttpClient(
    async (url, payload) => (await app.inject({ method: 'POST', url, payload })).json(),
    async () => ({ state: 'unconfigured', bindings: [] })
  );
  try {
    const projected = await bridge.invoke(request);
    expect(projected).toMatchObject({
      ok: true,
      value: { ...request.payload, commandId: request.commandId },
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE');
    expect(await http.invoke(request)).toEqual(projected);
    expect(router.request).toHaveBeenCalledTimes(2);
    expect(router.request).toHaveBeenLastCalledWith(request.handle, {
      commandId: request.commandId,
      method: request.operation,
      payload: request.payload,
      control: false,
    });
    router.request.mockClear();
    for (const draft of [
      { ...request.payload.draft, executable: '/PRIVATE/cli' },
      { ...request.payload.draft, providerId: 'ambient-default' },
      { ...request.payload.draft, target: { kind: 'lead', name: 'spoofed-member' } },
      {
        ...request.payload.draft,
        target: { kind: 'member', name: 'new-worker', memberId: 'foreign' },
      },
      { ...request.payload.draft, workspace: 'relative/project' },
      { ...request.payload.draft, workspace: '/TEST/project\nspoofed' },
    ]) {
      const malformed = { ...request, payload: { ...request.payload, draft } };
      expect(await handler({} as IpcMainInvokeEvent, malformed)).toEqual({
        ok: false,
        code: 'invalid',
        outcome: 'not-dispatched',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/agent-backend/operations',
            payload: malformed,
          })
        ).json()
      ).toEqual({ ok: false, code: 'invalid', outcome: 'not-dispatched' });
    }
    expect(router.request).not.toHaveBeenCalled();
    router.request.mockResolvedValue({ ok: false, code: 'hold', outcome: 'unknown' });
    expect(await bridge.invoke(request)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
    expect(router.request).toHaveBeenCalledTimes(1);
    expect(router.lookup).not.toHaveBeenCalled();
    router.request.mockResolvedValue({
      ok: true,
      value: {
        source: { sourceId: 'TEST-saved-source', rosterRevision: 'TEST-roster' },
        members: [
          {
            memberId: 'TEST-lead',
            label: 'team-lead',
            role: 'lead',
            selected: {
              provider: 'codex',
              model: 'TEST-model',
              workspace: '/TEST/lead',
              workspaceInherited: true,
              capabilities: ['model'],
            },
          },
          {
            memberId: 'TEST-member',
            label: 'member',
            role: 'member',
            selected: {
              provider: 'codex',
              model: 'TEST-model',
              workspace: '/TEST/member',
              workspaceInherited: false,
              capabilities: ['model'],
            },
          },
        ],
      },
    });
    expect(
      await bridge.invoke({
        ...request,
        operation: 'team.launch.model.configuration.read',
        payload: {},
      })
    ).toMatchObject({
      ok: true,
      value: {
        members: [
          { selected: { workspaceInherited: true } },
          { selected: { workspaceInherited: false } },
        ],
      },
    });
  } finally {
    dispose();
    await app.close();
  }
});
