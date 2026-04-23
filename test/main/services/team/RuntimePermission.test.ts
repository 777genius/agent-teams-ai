import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenCodePermissionAppRequestId,
  createRuntimePermissionRequestStore,
  normalizeOpenCodePermissionRequest,
  RuntimePermissionAnswerService,
  RuntimePermissionReconciler,
  type OpenCodeNormalizedPermissionRequest,
  type OpenCodePermissionClientPort,
  type OpenCodePermissionDecision,
  type RuntimePermissionDiagnosticEvent,
  type RuntimePermissionDiagnosticsSink,
  type RuntimePermissionLaunchMemberState,
  type RuntimePermissionLaunchStateStore,
  type RuntimePermissionRequestRecord,
} from '../../../../src/main/services/team/opencode/permissions/RuntimePermission';

describe('normalizeOpenCodePermissionRequest', () => {
  it('normalizes v1.14 permission payload', () => {
    const normalized = normalizeOpenCodePermissionRequest({
      id: 'perm_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['npm test'],
      metadata: { reason: 'test command' },
      always: ['npm test'],
      tool: { messageID: 'msg_1', callID: 'call_1', name: 'bash_tool' },
    });

    expect(normalized).toMatchObject({
      requestId: 'perm_1',
      sessionId: 'ses_1',
      permission: 'bash',
      toolName: 'bash_tool',
      toolCallId: 'call_1',
      messageId: 'msg_1',
      rawShape: 'v1.14',
      title: 'OpenCode wants bash permission for npm test',
      description: 'Patterns: npm test\nAlways candidates: npm test\nReason: test command',
    });
  });

  it('normalizes legacy local permission payload', () => {
    const normalized = normalizeOpenCodePermissionRequest({
      requestID: 'perm_legacy',
      sessionID: 'ses_legacy',
      tool: 'bash',
      title: 'Run command',
      kind: 'command',
    });

    expect(normalized).toMatchObject({
      requestId: 'perm_legacy',
      sessionId: 'ses_legacy',
      toolName: 'bash',
      title: 'Run command',
      description: 'command',
      rawShape: 'legacy',
    });
  });

  it('returns null for invalid payload without ids', () => {
    expect(normalizeOpenCodePermissionRequest({ permission: 'bash' })).toBeNull();
  });
});

describe('RuntimePermissionRequestStore and services', () => {
  let tempDir: string;
  let now: Date;
  let store: ReturnType<typeof createRuntimePermissionRequestStore>;
  let client: FakePermissionClient;
  let launchState: FakeLaunchStateStore;
  let diagnostics: FakeDiagnosticsSink;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-permissions-'));
    now = new Date('2026-04-21T12:00:00.000Z');
    store = createRuntimePermissionRequestStore({
      filePath: path.join(tempDir, 'permissions.json'),
      clock: () => now,
    });
    client = new FakePermissionClient();
    launchState = new FakeLaunchStateStore('run-1');
    diagnostics = new FakeDiagnosticsSink();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects approval for stale run', async () => {
    await store.upsertPending(permissionRecord({ runId: 'run-current' }));
    const service = answerService();

    await expect(
      service.answer({
        appRequestId: 'opencode:run-current:perm_1',
        runId: 'run-old',
        decision: 'once',
      })
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: ['Stale runId rejected'],
    });
    expect(client.answers).toEqual([]);
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_permission_stale_answer_rejected',
        severity: 'warning',
      })
    );
  });

  it('handles duplicate answer click as idempotent UI action', async () => {
    await store.upsertPending(permissionRecord());
    const service = answerService();

    await expect(
      service.answer({
        appRequestId: 'opencode:run-1:perm_1',
        runId: 'run-1',
        decision: 'once',
      })
    ).resolves.toMatchObject({
      ok: true,
      diagnostics: [],
    });
    await expect(
      service.answer({
        appRequestId: 'opencode:run-1:perm_1',
        runId: 'run-1',
        decision: 'once',
      })
    ).resolves.toMatchObject({
      ok: true,
      diagnostics: ['Permission already answered'],
    });
    expect(client.answers).toEqual([
      {
        requestId: 'perm_1',
        sessionId: 'ses_1',
        decision: 'once',
        message: undefined,
      },
    ]);
    await expect(store.get('opencode:run-1:perm_1')).resolves.toMatchObject({
      state: 'answered',
      decision: 'once',
      answerOrigin: 'user_click',
      answeredAt: '2026-04-21T12:00:00.000Z',
    });
  });

  it('projects reject side effects for same-session pending permissions', async () => {
    const firstId = createOpenCodePermissionAppRequestId('run-1', 'perm_1');
    const secondId = createOpenCodePermissionAppRequestId('run-1', 'perm_2');
    await store.upsertPending(permissionRecord({ appRequestId: firstId, providerRequestId: 'perm_1' }));
    await store.upsertPending(
      permissionRecord({
        appRequestId: secondId,
        providerRequestId: 'perm_2',
        patterns: ['npm run lint'],
      })
    );
    launchState.members.set('alice', {
      launchState: 'runtime_pending_permission',
      bootstrapConfirmed: false,
      pendingPermissionRequestIds: [firstId, secondId],
    });

    await expect(
      answerService().answer({
        appRequestId: firstId,
        runId: 'run-1',
        decision: 'reject',
      })
    ).resolves.toMatchObject({
      ok: true,
      diagnostics: [],
    });

    expect(client.answers).toEqual([
      {
        requestId: 'perm_1',
        sessionId: 'ses_1',
        decision: 'reject',
        message: undefined,
      },
    ]);
    await expect(store.get(firstId)).resolves.toMatchObject({
      state: 'answered',
      decision: 'reject',
      answerOrigin: 'user_click',
    });
    await expect(store.get(secondId)).resolves.toMatchObject({
      state: 'answered',
      decision: 'reject',
      answerOrigin: 'provider_side_effect_projection',
    });
    expect(launchState.members.get('alice')).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      pendingPermissionRequestIds: [],
    });
  });

  it('keeps confirmed_alive after answering the last pending permission', async () => {
    await store.upsertPending(permissionRecord());
    launchState.members.set('alice', {
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      pendingPermissionRequestIds: ['opencode:run-1:perm_1'],
    });

    await expect(
      answerService().answer({
        appRequestId: 'opencode:run-1:perm_1',
        runId: 'run-1',
        decision: 'once',
      })
    ).resolves.toMatchObject({
      ok: true,
      diagnostics: [],
    });

    expect(launchState.members.get('alice')).toMatchObject({
      launchState: 'confirmed_alive',
      pendingPermissionRequestIds: [],
    });
  });

  it('projects always only for exact pattern matches and reopens wrong projections on provider poll', async () => {
    const firstId = createOpenCodePermissionAppRequestId('run-1', 'perm_1');
    const secondId = createOpenCodePermissionAppRequestId('run-1', 'perm_2');
    const thirdId = createOpenCodePermissionAppRequestId('run-1', 'perm_3');
    await store.upsertPending(
      permissionRecord({
        appRequestId: firstId,
        providerRequestId: 'perm_1',
        patterns: ['npm test'],
        alwaysPatterns: ['npm test'],
      })
    );
    await store.upsertPending(
      permissionRecord({
        appRequestId: secondId,
        providerRequestId: 'perm_2',
        patterns: ['npm test'],
      })
    );
    await store.upsertPending(
      permissionRecord({
        appRequestId: thirdId,
        providerRequestId: 'perm_3',
        patterns: ['npm run lint'],
      })
    );
    launchState.members.set('alice', {
      launchState: 'runtime_pending_permission',
      bootstrapConfirmed: false,
      pendingPermissionRequestIds: [firstId, secondId, thirdId],
    });

    await expect(
      answerService().answer({
        appRequestId: firstId,
        runId: 'run-1',
        decision: 'always',
      })
    ).resolves.toMatchObject({
      ok: true,
      diagnostics: [],
    });

    await expect(store.get(firstId)).resolves.toMatchObject({
      state: 'answered',
      decision: 'always',
      answerOrigin: 'user_click',
    });
    await expect(store.get(secondId)).resolves.toMatchObject({
      state: 'answered',
      decision: 'always',
      answerOrigin: 'provider_side_effect_projection',
    });
    await expect(store.get(thirdId)).resolves.toMatchObject({
      state: 'pending',
      decision: null,
    });
    expect(launchState.members.get('alice')).toMatchObject({
      pendingPermissionRequestIds: [thirdId],
    });

    client.pending = [
      normalizedPermission({
        requestId: 'perm_2',
        sessionId: 'ses_1',
        patterns: ['npm test'],
      }),
      normalizedPermission({
        requestId: 'perm_3',
        sessionId: 'ses_1',
        patterns: ['npm run lint'],
      }),
    ];
    const reconciler = new RuntimePermissionReconciler(
      client,
      store,
      launchState,
      diagnostics,
      () => now
    );

    await reconciler.reconcile({
      runId: 'run-1',
      teamName: 'team-a',
      sessionsByOpenCodeId: new Map([
        ['ses_1', { runId: 'run-1', memberName: 'alice', runtimeSessionId: 'ses_1' }],
      ]),
    });

    await expect(store.get(secondId)).resolves.toMatchObject({
      state: 'pending',
      decision: null,
      answerOrigin: null,
    });
    expect(launchState.members.get('alice')).toMatchObject({
      pendingPermissionRequestIds: [secondId, thirdId],
    });
  });

  it('does not confirm member alive while permission is pending before bootstrap', async () => {
    client.pending = [
      normalizedPermission({
        requestId: 'perm_1',
        sessionId: 'ses_1',
        toolName: 'bash',
        patterns: ['npm test'],
        alwaysPatterns: ['npm test'],
      }),
    ];
    const reconciler = new RuntimePermissionReconciler(
      client,
      store,
      launchState,
      diagnostics,
      () => now
    );

    await reconciler.reconcile({
      runId: 'run-1',
      teamName: 'team-a',
      sessionsByOpenCodeId: new Map([
        ['ses_1', { runId: 'run-1', memberName: 'alice', runtimeSessionId: 'ses_1' }],
      ]),
    });

    expect(await store.listPendingForTeam('team-a')).toEqual([
      expect.objectContaining({
        appRequestId: 'opencode:run-1:perm_1',
        state: 'pending',
        memberName: 'alice',
        patterns: ['npm test'],
        alwaysPatterns: ['npm test'],
      }),
    ]);
    expect(launchState.members.get('alice')).toMatchObject({
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['opencode:run-1:perm_1'],
    });
  });

  it('expires local pending requests that disappeared from provider', async () => {
    await store.upsertPending(permissionRecord());
    await launchState.updateMember('team-a', 'alice', (member) => ({
      ...member,
      launchState: 'runtime_pending_permission',
      pendingPermissionRequestIds: ['opencode:run-1:perm_1'],
    }));
    client.pending = [];
    const reconciler = new RuntimePermissionReconciler(
      client,
      store,
      launchState,
      diagnostics,
      () => now
    );

    await reconciler.reconcile({
      runId: 'run-1',
      teamName: 'team-a',
      sessionsByOpenCodeId: new Map(),
    });

    await expect(store.get('opencode:run-1:perm_1')).resolves.toMatchObject({
      state: 'provider_missing',
      lastError: 'Provider no longer lists this permission request',
    });
    expect(launchState.members.get('alice')).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      pendingPermissionRequestIds: [],
    });
    expect(diagnostics.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode_permission_requests_expired',
        data: { expiredCount: 1 },
      })
    );
  });

  it('quarantines invalid permission store data', async () => {
    const filePath = path.join(tempDir, 'invalid-permissions.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-04-21T12:00:00.000Z',
        data: [{ appRequestId: '' }],
      }),
      'utf8'
    );
    const invalidStore = createRuntimePermissionRequestStore({
      filePath,
      clock: () => now,
    });

    await expect(invalidStore.list()).rejects.toMatchObject({
      reason: 'invalid_data',
    });
  });

  function answerService(): RuntimePermissionAnswerService {
    return new RuntimePermissionAnswerService(
      store,
      launchState,
      client,
      diagnostics,
      () => now
    );
  }
});

function permissionRecord(
  overrides: Partial<RuntimePermissionRequestRecord> = {}
): RuntimePermissionRequestRecord {
  return {
    appRequestId: createOpenCodePermissionAppRequestId(overrides.runId ?? 'run-1', 'perm_1'),
    providerRequestId: 'perm_1',
    runId: 'run-1',
    teamName: 'team-a',
    memberName: 'alice',
    providerId: 'opencode',
    runtimeSessionId: 'ses_1',
    permission: 'bash',
    patterns: [],
    alwaysPatterns: [],
    toolName: 'bash',
    title: 'Run command',
    description: null,
    state: 'pending',
    rawShape: 'v1.14',
    requestedAt: '2026-04-21T12:00:00.000Z',
    updatedAt: '2026-04-21T12:00:00.000Z',
    expiresAt: '2026-04-21T12:15:00.000Z',
    answeredAt: null,
    decision: null,
    answerOrigin: null,
    lastError: null,
    ...overrides,
  };
}

function normalizedPermission(
  overrides: Partial<OpenCodeNormalizedPermissionRequest> = {}
): OpenCodeNormalizedPermissionRequest {
  return {
    requestId: 'perm_1',
    sessionId: 'ses_1',
    permission: 'bash',
    patterns: [],
    alwaysPatterns: [],
    toolName: 'bash',
    toolCallId: null,
    messageId: null,
    title: 'Run command',
    description: null,
    metadata: {},
    rawShape: 'v1.14',
    raw: {},
    ...overrides,
  };
}

class FakePermissionClient implements OpenCodePermissionClientPort {
  pending: OpenCodeNormalizedPermissionRequest[] = [];
  answers: Array<{
    requestId: string;
    sessionId: string;
    decision: OpenCodePermissionDecision;
    message?: string;
  }> = [];

  async listPendingPermissions(): Promise<OpenCodeNormalizedPermissionRequest[]> {
    return this.pending;
  }

  async answerPermission(input: {
    requestId: string;
    sessionId: string;
    decision: OpenCodePermissionDecision;
    message?: string;
  }): Promise<void> {
    this.answers.push(input);
  }
}

class FakeLaunchStateStore implements RuntimePermissionLaunchStateStore {
  readonly members = new Map<string, RuntimePermissionLaunchMemberState>();

  constructor(public runId: string | null) {}

  async read(): Promise<{ runId: string | null }> {
    return { runId: this.runId };
  }

  async updateMember(
    _teamName: string,
    memberName: string,
    updater: (member: RuntimePermissionLaunchMemberState) => RuntimePermissionLaunchMemberState
  ): Promise<void> {
    const current = this.members.get(memberName) ?? {
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      pendingPermissionRequestIds: [],
    };
    this.members.set(memberName, updater(current));
  }
}

class FakeDiagnosticsSink implements RuntimePermissionDiagnosticsSink {
  readonly append = vi.fn(async (_event: RuntimePermissionDiagnosticEvent) => {});
}
