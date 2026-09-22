import { describe, expect, it, vi } from 'vitest';

import {
  type OpenCodePermissionClientPort,
  RuntimePermissionAnswerService,
  type RuntimePermissionDiagnosticsSink,
  type RuntimePermissionLaunchStateStore,
  type RuntimePermissionRequestRecord,
  type RuntimePermissionRequestStore,
} from '../RuntimePermission';

describe('RuntimePermissionAnswerService messages', () => {
  it('forwards a supplied message to the final OpenCode permission client', async () => {
    const { answerPermission, service } = createHarness();

    await service.answer({
      appRequestId: 'opencode:run-1:permission-1',
      runId: 'run-1',
      decision: 'once',
      message: 'Approved for the requested test command.',
    });

    expect(answerPermission).toHaveBeenCalledWith({
      requestId: 'permission-1',
      sessionId: 'session-1',
      decision: 'once',
      message: 'Approved for the requested test command.',
    });
  });

  it('keeps an undefined message compatible with the permission client', async () => {
    const { answerPermission, service } = createHarness();

    await service.answer({
      appRequestId: 'opencode:run-1:permission-1',
      runId: 'run-1',
      decision: 'once',
    });

    expect(answerPermission).toHaveBeenCalledWith({
      requestId: 'permission-1',
      sessionId: 'session-1',
      decision: 'once',
      message: undefined,
    });
  });
});

function createHarness() {
  const answerPermission = vi.fn<OpenCodePermissionClientPort['answerPermission']>(
    async (_input) => {}
  );
  const openCodeClient: OpenCodePermissionClientPort = {
    listPendingPermissions: vi.fn(async () => []),
    answerPermission,
  };
  const store = {
    beginAnswer: vi.fn(async () => ({ state: 'locked' as const, record: permissionRecord() })),
    markAnsweredWithSideEffects: vi.fn(async () => ({
      affectedAppRequestIds: ['opencode:run-1:permission-1'],
      sideEffects: [],
    })),
    listPendingForTeam: vi.fn(async () => []),
    markFailed: vi.fn(async () => {}),
  } as unknown as RuntimePermissionRequestStore;
  const launchStateStore: RuntimePermissionLaunchStateStore = {
    read: vi.fn(async () => ({ runId: 'run-1' })),
    updateMember: async (_teamName, _memberName, update) => {
      update({});
    },
  };
  const diagnostics: RuntimePermissionDiagnosticsSink = {
    append: vi.fn(async () => {}),
  };
  return {
    answerPermission,
    service: new RuntimePermissionAnswerService(
      store,
      launchStateStore,
      openCodeClient,
      diagnostics,
      () => new Date('2026-07-19T00:00:00.000Z')
    ),
  };
}

function permissionRecord(): RuntimePermissionRequestRecord {
  return {
    appRequestId: 'opencode:run-1:permission-1',
    providerRequestId: 'permission-1',
    runId: 'run-1',
    teamName: 'team-a',
    memberName: 'Worker',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    permission: 'bash',
    patterns: [],
    alwaysPatterns: [],
    toolName: 'bash',
    title: 'Run command',
    description: null,
    state: 'answering',
    rawShape: 'v1.14',
    requestedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-19T00:15:00.000Z',
    answeredAt: null,
    decision: null,
    answerOrigin: null,
    lastError: null,
  };
}
