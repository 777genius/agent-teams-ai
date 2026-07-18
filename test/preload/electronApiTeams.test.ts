import {
  type CanonicalListTeamLifecycleResult,
  type ListTeamLifecycleRequest,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '@features/team-lifecycle/contracts';
import { parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '@shared/types/api';

const mocks = vi.hoisted(() => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  },
  webUtils: {
    getPathForFile: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  contextBridge: mocks.contextBridge,
  ipcRenderer: mocks.ipcRenderer,
  webUtils: mocks.webUtils,
}));

function getElectronApi(): ElectronAPI {
  const call = mocks.contextBridge.exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'electronAPI'
  );
  if (!call) throw new Error('Expected electronAPI to be exposed in preload');
  return call[1] as ElectronAPI;
}

describe('preload electronAPI team lifecycle wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete (window as Window & { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__;
    mocks.contextBridge.exposeInMainWorld.mockClear();
    mocks.ipcRenderer.invoke.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forwards the strict request and projects additive canonical response fields', async () => {
    await import('../../src/preload/index');
    const request: ListTeamLifecycleRequest = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      cursor: null,
      expectedRevision: null,
    };
    const expected = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      snapshotRevision: parseRevision('revision_aaaaaaaa'),
      items: [
        {
          workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
          teamId: parseTeamId(`team_${'c'.repeat(32)}`),
          displayName: 'preload-team',
          lifecycle: 'ready',
          revision: parseRevision('revision_bbbbbbbb'),
        },
      ],
      nextCursor: null,
    } satisfies CanonicalListTeamLifecycleResult;
    mocks.ipcRenderer.invoke.mockResolvedValueOnce({
      ...expected,
      items: expected.items.map((item) => ({ ...item, additiveItemField: 'ignored' })),
      additiveEnvelopeField: 'ignored',
    });

    await expect(getElectronApi().listTeamLifecycle(request)).resolves.toEqual(expected);
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('team:list', request);
  });

  it('contains malformed responses and rejected IPC without exposing diagnostics', async () => {
    await import('../../src/preload/index');
    const request: ListTeamLifecycleRequest = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      cursor: null,
      expectedRevision: null,
    };
    mocks.ipcRenderer.invoke
      .mockResolvedValueOnce({ kind: 'success', privatePath: '/private/project' })
      .mockRejectedValueOnce(new Error('private sqlite diagnostic /private/project'));

    const malformed = await getElectronApi().listTeamLifecycle(request);
    expect(malformed).toEqual({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: {
        code: 'internal',
        reason: 'source_response_invalid',
        diagnosticId: 'team-lifecycle-read.response-invalid',
      },
      retryable: false,
    });
    expect(JSON.stringify(malformed)).not.toContain('/private/project');

    const rejected = await getElectronApi().listTeamLifecycle(request);
    expect(rejected).toEqual({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: { code: 'unavailable', reason: 'transport_unavailable' },
      retryable: true,
    });
    expect(JSON.stringify(rejected)).not.toContain('private sqlite diagnostic');
  });
});
