import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { isPreparedSendAllowed } from '@renderer/components/team/messages/composerSendUtils';
import { attachmentTargetForMember } from '@renderer/utils/attachmentRecipientCapabilities';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_CATALOG_FRESHNESS_MS } from './loadOpenCodeScopedCatalog';
import { useOpenCodeAttachmentDeclarations } from './useOpenCodeAttachmentDeclarations';

import type { RuntimeProviderManagementModelsResponse } from '../../contracts';
import type { OpenCodeAttachmentTarget } from './useOpenCodeAttachmentDeclarations';
import type { ComposerDraftContent, ComposerPreparedRequest } from '@renderer/types/composerDraft';
import type { ResolvedTeamMember } from '@shared/types';

const transport = vi.hoisted(() => ({
  loadModels: vi.fn(),
  cancelModelLoad: vi.fn().mockResolvedValue({}),
}));
vi.mock('@renderer/api', () => ({ api: { runtimeProviderManagement: transport } }));

const first = { projectPath: '/sandbox/first', model: 'custom-local/FutureModel' };
const second = { projectPath: '/sandbox/second', model: 'other-provider/FutureModel' };
function response(
  providerId: string,
  declaration: string[]
): RuntimeProviderManagementModelsResponse {
  return {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId,
      defaultModelId: null,
      diagnostics: [],
      catalogState: 'fresh',
      models: [
        {
          providerId,
          modelId: 'FutureModel',
          displayName: 'Future',
          sourceLabel: 'Local',
          free: true,
          default: false,
          availability: 'available',
          declaredInputModalities: declaration,
        },
      ],
    },
  };
}
function member(model: string, cwd?: string): ResolvedTeamMember {
  return {
    name: 'teammate',
    providerId: 'opencode',
    model,
    cwd,
    status: 'idle',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
  };
}
let latest: ReturnType<typeof useOpenCodeAttachmentDeclarations>;
function Probe({ target }: { target: OpenCodeAttachmentTarget }) {
  latest = useOpenCodeAttachmentDeclarations([target]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  transport.loadModels.mockReset();
  transport.cancelModelLoad.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OpenCode attachment catalog admission', () => {
  it('invalidates old scopes immediately and ignores their late response', async () => {
    let finishFirst!: (value: RuntimeProviderManagementModelsResponse) => void;
    let finishSecond!: (value: RuntimeProviderManagementModelsResponse) => void;
    transport.loadModels
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = resolve;
          })
      );
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe target={first} />));
    await act(async () => root.render(<Probe target={second} />));
    expect(latest.read(second).declaredInputModalities).toBeNull();
    await act(async () => finishFirst(response('custom-local', ['image'])));
    expect(latest.read(second).declaredInputModalities).toBeNull();
    await act(async () => finishSecond(response('other-provider', ['video'])));
    expect(latest.read(second).declaredInputModalities).toEqual(['video']);
    expect(latest.read(first).declaredInputModalities).toBeNull();
    expect(transport.cancelModelLoad).toHaveBeenCalledWith({
      requestGroupId: expect.stringContaining('attachment-declarations:'),
    });
    expect(transport.loadModels.mock.calls[1][0]).toMatchObject({
      projectPath: second.projectPath,
      providerId: 'other-provider',
      refresh: false,
    });
    transport.loadModels.mockReturnValueOnce(new Promise(() => undefined));
    const changedModel = { ...second, model: 'other-provider/ChangedModel' };
    await act(async () => root.render(<Probe target={changedModel} />));
    expect(latest.read(second).declaredInputModalities).toBeNull();
    expect(transport.loadModels).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
  });

  it('explicit refresh bypasses a cached stale success while automatic scope reads use the cache', async () => {
    const stale = response('custom-local', ['image']);
    stale.models!.catalogState = 'stale';
    transport.loadModels
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(response('custom-local', ['image']));
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe target={first} />));
    expect(latest.read(first).declaredInputModalities).toBeNull();
    expect(transport.loadModels.mock.calls[0][0].refresh).toBe(false);
    await act(async () => latest.refresh());
    expect(transport.loadModels.mock.calls[1][0].refresh).toBe(true);
    expect(latest.read(first).declaredInputModalities).toEqual(['image']);
    await act(async () => root.render(<Probe target={second} />));
    expect(transport.loadModels.mock.calls[2][0].refresh).toBe(false);
    await act(async () => root.unmount());
  });

  it('blocks expired prepared sends synchronously and explicit refresh recovers without changing payload or target', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
    transport.loadModels.mockResolvedValue(response('custom-local', ['image']));
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe target={first} />));
    const recipient = member(first.model);
    const content: ComposerDraftContent = {
      text: 'hello',
      chips: [],
      actionMode: 'do',
      attachments: [
        { id: 'image', filename: 'image.png', mimeType: 'image/png', size: 12, data: 'aW1n' },
      ],
    };
    const request: ComposerPreparedRequest = {
      kind: 'local',
      teamName: 'sandbox',
      request: {
        member: recipient.name,
        text: content.text,
        attachments: content.attachments,
      },
    };
    const before = JSON.stringify(request);
    const allowed = () =>
      isPreparedSendAllowed(content, request, [recipient], 'sandbox', true, (target) =>
        latest.read(attachmentTargetForMember(target, first.projectPath))
      );
    expect(allowed()).toBe(true);
    vi.setSystemTime(Date.now() + MODEL_CATALOG_FRESHNESS_MS + 1);
    expect(allowed()).toBe(false);
    expect(latest.read(first).unavailableReason).toContain('expired');
    expect(transport.loadModels).toHaveBeenCalledOnce();
    await act(async () => latest.refresh());
    expect(allowed()).toBe(true);
    expect(transport.loadModels).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(request)).toBe(before);
    const other = member('custom-local/MissingModel');
    expect(
      isPreparedSendAllowed(content, request, [other], 'sandbox', true, (target) =>
        latest.read(attachmentTargetForMember(target, first.projectPath))
      )
    ).toBe(false);
    await act(async () => root.unmount());
  });

  it('uses secondary member cwd and the already resolved live default/solo model', () => {
    const live = member('custom-local/ResolvedDefault', '/sandbox/member-worktree');
    expect(attachmentTargetForMember(live, '/sandbox/team')).toEqual({
      model: live.model,
      projectPath: '/sandbox/team',
    });
    expect(
      attachmentTargetForMember(
        { ...live, laneKind: 'secondary', laneOwnerProviderId: 'opencode' },
        '/sandbox/team'
      )
    ).toEqual({ model: live.model, projectPath: live.cwd });
    expect(
      attachmentTargetForMember({ ...live, name: 'team-lead', model: undefined }, '/sandbox/team')
        .model
    ).toBeUndefined();
  });
});
