/* eslint-disable @typescript-eslint/no-explicit-any */
import { promises as fsPromises } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  let atomicWriteShouldFail = false;

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const stat = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    const size = Buffer.byteLength(data, 'utf8');
    return {
      isFile: () => true,
      size,
      mode: 0o100644,
      dev: 1,
      ino: 1,
      mtimeMs: 1,
      ctimeMs: 1,
      birthtimeMs: 1,
      mtimeNs: 1n,
      ctimeNs: 1n,
      birthtimeNs: 1n,
    };
  });

  const readFile = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });

  const atomicWrite = vi.fn(async (filePath: string, data: string) => {
    if (atomicWriteShouldFail) {
      throw new Error('atomic write failed');
    }
    files.set(norm(filePath), data);
  });
  const mkdir = vi.fn(async () => undefined);

  return {
    files,
    stat,
    readFile,
    mkdir,
    atomicWrite,
    appendSentMessage: vi.fn((teamName: string, message: Record<string, unknown>) => {
      const sentMessagesPath = `/mock/teams/${teamName}/sentMessages.json`;
      const current = files.get(sentMessagesPath);
      const rows = current ? (JSON.parse(current) as unknown[]) : [];
      rows.push(message);
      files.set(sentMessagesPath, JSON.stringify(rows));
      return message;
    }),
    sendInboxMessage: vi.fn((teamName: string, message: Record<string, unknown>) => {
      const member =
        typeof message.member === 'string'
          ? message.member
          : typeof message.to === 'string'
            ? message.to
            : 'unknown';
      const p = `/mock/teams/${teamName}/inboxes/${member}.json`;
      const current = files.get(p);
      const rows = current ? (JSON.parse(current) as unknown[]) : [];
      rows.push(message);
      files.set(p, JSON.stringify(rows));
      return { deliveredToInbox: true, messageId: 'mock-id', message };
    }),
    setAtomicWriteShouldFail: (next: boolean) => {
      atomicWriteShouldFail = next;
    },
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: hoisted.stat,
      readFile: hoisted.readFile,
      mkdir: hoisted.mkdir,
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: hoisted.stat,
    readFile: hoisted.readFile,
    mkdir: hoisted.mkdir,
  };
});

vi.mock('../../../../src/main/services/team/atomicWrite', () => ({
  atomicWriteAsync: hoisted.atomicWrite,
}));

vi.mock('../../../../src/main/services/team/fileLock', () => ({
  withFileLock: async (_filePath: string, fn: () => Promise<unknown>) => await fn(),
  withFileLockSync: (_filePath: string, fn: () => unknown) => fn(),
}));

vi.mock('../../../../src/main/services/team/inboxLock', () => ({
  withInboxLock: async (_filePath: string, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock('../../../../src/main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/pathDecoder')>();
  return {
    ...actual,
    getTeamsBasePath: () => '/mock/teams',
  };
});

vi.mock('../../../../src/main/utils/fsRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/fsRead')>();
  return {
    ...actual,
    readFileUtf8WithTimeout: hoisted.readFile,
  };
});

vi.mock(
  '../../../../src/main/services/team/provisioning/TeamProvisioningInboxRelayPolicy',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/main/services/team/provisioning/TeamProvisioningInboxRelayPolicy')
      >();
    return {
      ...actual,
      inferOpenCodeInboxMessageTaskRefs: vi.fn(actual.inferOpenCodeInboxMessageTaskRefs),
    };
  }
);

vi.mock('agent-teams-controller', () => ({
  AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES: [] as readonly string[],
  AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES: [] as readonly string[],
  AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES: [] as readonly string[],
  createController: ({ teamName }: { teamName: string }) => ({
    messages: {
      appendSentMessage: (message: Record<string, unknown>) =>
        hoisted.appendSentMessage(teamName, message),
      sendMessage: (message: Record<string, unknown>) =>
        hoisted.sendInboxMessage(teamName, message),
    },
  }),
  protocols: {
    buildActionModeProtocolText: (delegate: string) =>
      `ACTION MODE PROTOCOL (mock, delegate: ${delegate})`,
    buildProcessProtocolText: (teamName: string) =>
      `BACKGROUND PROCESS REGISTRATION (mock for ${teamName})`,
  },
}));

import { buildLegacyInboxMessageId } from '../../../../src/main/services/team/inboxMessageIdentity';
import { isOpenCodePromptAcceptedByObservation } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryReadCommitPolicy';
import * as OpenCodeRuntimeStore from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { inferOpenCodeInboxMessageTaskRefs } from '../../../../src/main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';
import { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime';
import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { getTeamsBasePath } from '../../../../src/main/utils/pathDecoder';

function seedConfig(teamName: string): void {
  hoisted.files.set(
    `/mock/teams/${teamName}/config.json`,
    JSON.stringify({
      name: 'My Team',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    })
  );
}

function seedLeadInbox(teamName: string, messages: unknown[]): void {
  hoisted.files.set(`/mock/teams/${teamName}/inboxes/team-lead.json`, JSON.stringify(messages));
}

function seedMemberInbox(teamName: string, memberName: string, messages: unknown[]): void {
  hoisted.files.set(`/mock/teams/${teamName}/inboxes/${memberName}.json`, JSON.stringify(messages));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function attachAliveRun(
  service: TeamProvisioningService,
  teamName: string,
  opts?: { writable?: boolean; runId?: string; provisioningComplete?: boolean }
): { writeSpy: ReturnType<typeof vi.fn>; runId: string } {
  const runId = opts?.runId ?? 'run-1';
  const writeSpy = vi.fn((_data: unknown, cb?: (err?: Error | null) => void) => {
    if (typeof cb === 'function') cb(null);
    return true;
  });
  const writable = opts?.writable ?? true;

  (service as unknown as { aliveRunByTeam: Map<string, string> }).aliveRunByTeam.set(
    teamName,
    runId
  );
  (service as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
    runId,
    teamName,
    request: {
      teamName,
      members: [{ name: 'team-lead', role: 'team-lead' }],
    },
    startedAt: '2026-02-23T09:59:00.000Z',
    leadMsgSeq: 0,
    pendingToolCalls: [],
    activeToolCalls: new Map(),
    pendingDirectCrossTeamSendRefresh: false,
    lastLeadTextEmitMs: 0,
    activeCrossTeamReplyHints: [],
    pendingInboxRelayCandidates: [],
    pendingApprovals: new Map(),
    processedPermissionRequestIds: new Set(),
    silentUserDmForward: null,
    silentUserDmForwardClearHandle: null,
    child: {
      stdin: {
        writable,
        write: writeSpy,
      },
    },
    processKilled: false,
    cancelRequested: false,
    provisioningComplete: opts?.provisioningComplete ?? true,
    leadRelayCapture: null,
  });

  return { writeSpy, runId };
}

function buildOpenCodeProofMissingRecord(input: {
  teamName: string;
  memberName: string;
  laneId: string;
  inboxMessageId: string;
  taskRefs: Array<{ teamName: string; taskId: string; displayId: string }>;
}): Record<string, unknown> {
  return {
    id: `opencode-prompt:${input.inboxMessageId}`,
    teamName: input.teamName,
    memberName: input.memberName,
    laneId: input.laneId,
    runId: null,
    runtimeSessionId: null,
    inboxMessageId: input.inboxMessageId,
    inboxTimestamp: '2026-02-23T17:31:00.000Z',
    source: 'watcher',
    messageKind: 'default',
    replyRecipient: 'team-lead',
    actionMode: 'do',
    taskRefs: input.taskRefs,
    payloadHash: 'sha256:test',
    status: 'failed_terminal',
    responseState: 'responded_non_visible_tool',
    attempts: 3,
    maxAttempts: 3,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: '2026-02-23T17:31:10.000Z',
    lastObservedAt: '2026-02-23T17:31:15.000Z',
    acceptedAt: '2026-02-23T17:31:05.000Z',
    respondedAt: '2026-02-23T17:31:15.000Z',
    failedAt: '2026-02-23T17:31:20.000Z',
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'msg-user',
    observedAssistantMessageId: 'msg-assistant',
    observedAssistantPreview: null,
    observedToolCallNames: ['task_get', 'glob'],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: 'non_visible_tool_without_task_progress',
    diagnostics: ['non_visible_tool_without_task_progress'],
    createdAt: '2026-02-23T17:31:00.000Z',
    updatedAt: '2026-02-23T17:31:20.000Z',
  };
}

function seedOpenCodeBusyStatusFixture(input: {
  service: TeamProvisioningService;
  teamName: string;
  laneId: string;
  inboxMessages: unknown[];
  memberName?: string;
  laneState?: 'active' | 'stopped';
  ledgerRecords?: Record<string, unknown>[];
  activeRecord?: Record<string, unknown> | null;
}): void {
  const memberName = input.memberName ?? 'jack';
  const teamsBasePath = getTeamsBasePath();
  hoisted.files.set(
    `${teamsBasePath}/${input.teamName}/config.json`,
    JSON.stringify({
      name: input.teamName,
      projectPath: '/tmp/my-team',
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: memberName, role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
      ],
    })
  );
  hoisted.files.set(
    `${teamsBasePath}/${input.teamName}/inboxes/${memberName}.json`,
    JSON.stringify(input.inboxMessages)
  );
  (input.service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
    ok: true,
    canonicalMemberName: memberName,
    laneId: input.laneId,
  }));
  vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
    version: 1,
    updatedAt: '2026-02-23T17:30:00.000Z',
    lanes: {
      [input.laneId]: {
        laneId: input.laneId,
        state: input.laneState ?? 'active',
        updatedAt: '2026-02-23T17:30:00.000Z',
      },
    },
  });
  vi.spyOn(input.service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
    list: vi.fn(async () => input.ledgerRecords ?? []),
    getActiveForMember: vi.fn(async () => input.activeRecord ?? null),
  });
}

async function waitForCapture(service: TeamProvisioningService): Promise<any> {
  const runs = (service as unknown as { runs: Map<string, unknown> }).runs;
  const run = runs.get('run-1') as any;
  for (let i = 0; i < 50; i++) {
    if (run?.leadRelayCapture) return run;
    // Progress async awaits in relayLeadInboxMessages
    await Promise.resolve();
  }
  for (let i = 0; i < 50; i++) {
    if (run?.leadRelayCapture) return run;
    await new Promise((r) => setTimeout(r, 0));
  }
  return run;
}

describe('TeamProvisioningService relayLeadInboxMessages', () => {
  beforeEach(() => {
    TeamConfigReader.clearCacheForTests();
    hoisted.files.clear();
    hoisted.readFile.mockClear();
    hoisted.mkdir.mockClear();
    hoisted.atomicWrite.mockClear();
    hoisted.setAtomicWriteShouldFail(false);
    hoisted.appendSentMessage.mockClear();
    hoisted.sendInboxMessage.mockClear();
    hoisted.setAtomicWriteShouldFail(false);
    vi.spyOn(fsPromises, 'mkdir').mockImplementation(hoisted.mkdir as never);
  });

  it('relays unread lead inbox messages into stdin', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Please assign this to Alice.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Need delegation',
        messageId: 'm-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);

    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'OK, will do.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    const relayed = await relayPromise;

    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('"type":"user"');
    expect(payload).toContain('Please assign this to Alice.');
    expect(service.getLiveLeadProcessMessages(teamName)).toHaveLength(1);
  });

  it('does not persist echoed lead relay prompts as user-visible replies', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'tom',
        text: '#f8d7235a done.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: '#f8d7235a done',
        messageId: 'm-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0] ?? '{}')) as {
      message?: { content?: Array<{ text?: string }> };
    };
    const relayedPrompt = payload.message?.content?.[0]?.text ?? '';

    expect(relayedPrompt).toContain('You have new inbox messages addressed to you');

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: `Human: ${relayedPrompt}` }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    expect(service.getLiveLeadProcessMessages(teamName)).toHaveLength(0);
    expect(hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`)).toBeUndefined();
  });

  it('does not persist bare transcript speaker placeholders as lead replies', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'tom',
        text: '#f8d7235a done.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: '#f8d7235a done',
        messageId: 'm-1',
      },
    ]);

    attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Human: ' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    expect(service.getLiveLeadProcessMessages(teamName)).toHaveLength(0);
    expect(hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`)).toBeUndefined();
  });

  it('records non-user lead relay summary text as internal lead activity', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'tom',
        text: '#f8d7235a done.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: '#f8d7235a done',
        messageId: 'm-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0] ?? '{}')) as {
      message?: { content?: Array<{ text?: string }> };
    };
    const relayedPrompt = payload.message?.content?.[0]?.text ?? '';
    expect(relayedPrompt).toContain(
      'Do not use that internal status line to confirm, correct, or relay task, kanban, review, PR, branch, merge, or queue state unless you verified it with the source-of-truth tool in this turn.'
    );
    expect(relayedPrompt).toContain(
      'Treat teammate/system/cross-team claims about task, kanban, review, PR, branch, merge, or queue state as unverified until checked.'
    );

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: `Human: ${relayedPrompt}\n\nDelegated to bob.` }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    const live = service.getLiveLeadProcessMessages(teamName);
    expect(live.map((message) => message.text)).toEqual(['Delegated to bob.']);
    expect(live[0]?.to).toBeUndefined();
    expect(hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`)).toBeUndefined();
  });

  it('suppresses unverified non-user lead relay state claims from internal activity', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'tom',
        text: '#f8d7235a done.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: '#f8d7235a done',
        messageId: 'm-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0] ?? '{}')) as {
      message?: { content?: Array<{ text?: string }> };
    };
    const relayedPrompt = payload.message?.content?.[0]?.text ?? '';

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [
        {
          type: 'text',
          text:
            `Human: ${relayedPrompt}\n\n` +
            'Confirmed - both claims in msg 17eb3109 were false. #38730980 already approved and PR #38 is OPEN, mergeCommit=null.',
        },
      ],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    expect(service.getLiveLeadProcessMessages(teamName)).toHaveLength(0);
    expect(hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`)).toBeUndefined();
  });

  it.each([
    {
      caseName: 'keeps task-ref delegation status',
      replyText: 'Delegated #f8d7235a to bob.',
      expectedLiveText: 'Delegated #f8d7235a to bob.',
    },
    {
      caseName: 'keeps verification-needed status',
      replyText: 'Verification needed before confirming #f8d7235a.',
      expectedLiveText: 'Verification needed before confirming #f8d7235a.',
    },
    {
      caseName: 'suppresses completed task claim',
      replyText: 'Task #f8d7235a is completed.',
      expectedLiveText: null,
    },
    {
      caseName: 'suppresses merged PR claim',
      replyText: 'PR #38 merged.',
      expectedLiveText: null,
    },
    {
      caseName: 'suppresses queue-clear claim',
      replyText: 'Queue genuinely clear for #f8d7235a.',
      expectedLiveText: null,
    },
  ])(
    'classifies non-user lead relay internal activity: $caseName',
    async ({ caseName, replyText, expectedLiveText }) => {
      const service = new TeamProvisioningService();
      const teamName = `my-team-${caseName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
      seedConfig(teamName);
      seedLeadInbox(teamName, [
        {
          from: 'tom',
          text: '#f8d7235a done.',
          timestamp: '2026-02-23T10:00:00.000Z',
          read: false,
          summary: '#f8d7235a done',
          messageId: 'm-1',
        },
      ]);

      const { writeSpy } = attachAliveRun(service, teamName);
      const relayPromise = service.relayLeadInboxMessages(teamName);
      const run = await waitForCapture(service);
      const payload = JSON.parse(String(writeSpy.mock.calls[0]?.[0] ?? '{}')) as {
        message?: { content?: Array<{ text?: string }> };
      };
      const relayedPrompt = payload.message?.content?.[0]?.text ?? '';

      (service as any).handleStreamJsonMessage(run, {
        type: 'assistant',
        content: [{ type: 'text', text: `Human: ${relayedPrompt}\n\n${replyText}` }],
      });
      (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

      await expect(relayPromise).resolves.toBe(1);
      const liveTexts = service.getLiveLeadProcessMessages(teamName).map((message) => message.text);
      expect(liveTexts).toEqual(expectedLiveText === null ? [] : [expectedLiveText]);
      expect(hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`)).toBeUndefined();
    }
  );

  it('keeps user-originated lead relay replies user-visible', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'user',
        text: 'Create the docs task.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Docs task',
        messageId: 'user-msg-1',
        source: 'user_sent',
      },
    ]);

    attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Creating the task now.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    const live = service.getLiveLeadProcessMessages(teamName);
    expect(live.map((message) => message.text)).toEqual(['Creating the task now.']);
    expect(live[0]?.to).toBe('user');
    const sentRows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`) ?? '[]'
    ) as Array<{
      text?: string;
      to?: string;
    }>;
    expect(sentRows).toMatchObject([{ text: 'Creating the task now.', to: 'user' }]);
  });

  it('does not suppress state-like user-originated lead relay replies', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'user',
        text: 'What is the task status?',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Task status',
        messageId: 'user-msg-state-like',
        source: 'user_sent',
      },
    ]);

    attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Task #f8d7235a is completed.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    const live = service.getLiveLeadProcessMessages(teamName);
    expect(live.map((message) => ({ to: message.to, text: message.text }))).toEqual([
      { to: 'user', text: 'Task #f8d7235a is completed.' },
    ]);
    const sentRows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`) ?? '[]'
    ) as Array<{ text?: string; to?: string }>;
    expect(sentRows).toMatchObject([{ to: 'user', text: 'Task #f8d7235a is completed.' }]);
  });

  it('does not mix internal lead relay rows into a user-visible relay batch', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Internal status for the lead.',
        timestamp: '2026-02-23T09:59:00.000Z',
        read: false,
        summary: 'Internal status',
        messageId: 'internal-msg-1',
      },
      {
        from: 'user',
        text: 'Please create the release task.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Release task',
        messageId: 'user-msg-2',
        source: 'user_sent',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Creating the release task.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('Please create the release task.');
    expect(payload).not.toContain('Internal status for the lead.');

    await vi.waitFor(() => expect(writeSpy.mock.calls.length).toBe(2), { timeout: 1000 });
    const followUpRun = await waitForCapture(service);
    (service as any).handleStreamJsonMessage(followUpRun, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Noted internal status.' }],
    });
    (service as any).handleStreamJsonMessage(followUpRun, { type: 'result', subtype: 'success' });
  });

  it('relays deferred internal rows on the next pass after a user-visible batch', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Internal status for the lead.',
        timestamp: '2026-02-23T09:59:00.000Z',
        read: false,
        summary: 'Internal status',
        messageId: 'internal-msg-next-pass',
        source: 'system_notification',
      },
      {
        from: 'user',
        text: 'Please create the release task.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Release task',
        messageId: 'user-msg-next-pass',
        source: 'user_sent',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const firstPromise = service.relayLeadInboxMessages(teamName);
    let run = await waitForCapture(service);
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Creating the release task.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    await expect(firstPromise).resolves.toBe(1);

    await vi.waitFor(() => expect(writeSpy.mock.calls.length).toBe(2), { timeout: 1000 });
    run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Noted internal status.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    await vi.waitFor(() => expect(service.getLiveLeadProcessMessages(teamName)).toHaveLength(2));

    const firstPayload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const secondPayload = String(writeSpy.mock.calls[1]?.[0] ?? '');
    expect(firstPayload).toContain('Please create the release task.');
    expect(firstPayload).not.toContain('Internal status for the lead.');
    expect(secondPayload).toContain('Internal status for the lead.');
    const live = service.getLiveLeadProcessMessages(teamName);
    expect(live.map((message) => ({ to: message.to, text: message.text }))).toEqual([
      { to: 'user', text: 'Creating the release task.' },
      { to: undefined, text: 'Noted internal status.' },
    ]);
  });

  it('does not duplicate relay narration when the lead sends an explicit visible message', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'This needs the user to know.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Notify user',
        messageId: 'internal-msg-2',
      },
    ]);

    attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Sending the user update now.' },
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            recipient: 'user',
            content: 'Bob found an issue that needs your attention.',
            summary: 'Needs attention',
          },
        },
      ],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    const live = service.getLiveLeadProcessMessages(teamName);
    expect(live.map((message) => message.text)).toEqual([
      'Bob found an issue that needs your attention.',
    ]);
    const sentRows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`) ?? '[]'
    ) as Array<{ text?: string }>;
    expect(sentRows.map((message) => message.text)).toEqual([
      'Bob found an issue that needs your attention.',
    ]);
  });

  it('keeps explicit teammate SendMessage from non-user lead relay visible', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Alice should review the release notes.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Ask Alice',
        messageId: 'internal-msg-teammate-send',
      },
    ]);

    attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Sending Alice the handoff.' },
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            recipient: 'alice',
            content: 'Please review the release notes.',
            summary: 'Review release notes',
          },
        },
      ],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    const live = service.getLiveLeadProcessMessages(teamName);
    expect(live.map((message) => ({ to: message.to, text: message.text }))).toEqual([
      { to: 'alice', text: 'Please review the release notes.' },
    ]);
    const aliceInbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ member?: string; text?: string }>;
    expect(aliceInbox).toMatchObject([
      { member: 'alice', text: 'Please review the release notes.' },
    ]);
    expect(hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`)).toBeUndefined();
  });

  it('keeps user-originated plain reply when the lead also messages a teammate', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'user',
        text: 'Please ask Alice to review the release notes.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Review release notes',
        messageId: 'user-msg-3',
        source: 'user_sent',
      },
    ]);

    attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Asked Alice to review the release notes.' },
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            recipient: 'alice',
            content: 'Please review the release notes.',
            summary: 'Review release notes',
          },
        },
      ],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    const live = service.getLiveLeadProcessMessages(teamName);
    expect(live.map((message) => ({ to: message.to, text: message.text }))).toEqual([
      { to: 'alice', text: 'Please review the release notes.' },
      { to: 'user', text: 'Asked Alice to review the release notes.' },
    ]);
    const sentRows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/sentMessages.json`) ?? '[]'
    ) as Array<{ text?: string; to?: string }>;
    expect(sentRows).toMatchObject([
      { to: 'user', text: 'Asked Alice to review the release notes.' },
    ]);
  });

  it('treats member work sync nudges as actionable in lead relay prompt', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    service.setControlApiBaseUrlResolver(async () => 'http://127.0.0.1:43123');
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'system',
        text: 'Work sync check: you have current actionable work assigned.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Work sync check',
        messageId: 'm-work-sync-1',
        source: 'system_notification',
        messageKind: 'member_work_sync_nudge',
        workSyncIntent: 'agenda_sync',
        taskRefs: [{ teamName, taskId: 'task-1', displayId: '11111111' }],
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();

    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('Message kind: member_work_sync_nudge');
    expect(payload).toContain('Work-sync intent: agenda_sync');
    expect(payload).toContain('it is actionable work-sync control traffic');
    expect(payload).toContain('A member_work_sync_status call alone is incomplete');
    expect(payload).toContain(
      'Call member_work_sync_status with teamName=\\"my-team\\", memberName=\\"team-lead\\", controlUrl=\\"http://127.0.0.1:43123\\"'
    );
    expect(payload).toContain('call member_work_sync_report');
    expect(payload).toContain('controlUrl=\\"http://127.0.0.1:43123\\"');
    expect(payload).toContain('taskIds from the nudge task refs');
    expect(payload).toContain(
      'Do not use provider names, runtime names, or team names as memberName'
    );
    expect(payload).toContain('Do NOT ignore it as a pure system notification');

    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    await expect(relayPromise).resolves.toBe(1);
  });

  it('uses snapshot config reads for lead inbox relay routing', async () => {
    const getConfig = vi.fn(async () => {
      throw new Error('verified config read should not be used for inbox relay routing');
    });
    const getConfigSnapshot = vi.fn(async () => ({
      name: 'My Team',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    }));
    const service = new TeamProvisioningService({
      getConfig,
      getConfigSnapshot,
    } as any);
    const teamName = 'my-team';
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Please assign this to Alice.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Need delegation',
        messageId: 'm-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'OK, will do.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await expect(relayPromise).resolves.toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(getConfigSnapshot).toHaveBeenCalledWith(teamName);
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('shows assistant text after relay capture has already settled', () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    attachAliveRun(service, teamName);

    const run = (service as unknown as { runs: Map<string, unknown> }).runs.get('run-1') as {
      leadRelayCapture: {
        leadName: string;
        startedAt: string;
        textParts: string[];
        settled: boolean;
        idleHandle: NodeJS.Timeout | null;
        idleMs: number;
        resolveOnce: (text: string) => void;
        rejectOnce: (error: string) => void;
        timeoutHandle: NodeJS.Timeout;
      } | null;
    };

    run.leadRelayCapture = {
      leadName: 'team-lead',
      startedAt: new Date().toISOString(),
      textParts: [],
      settled: true,
      idleHandle: null,
      idleMs: 800,
      resolveOnce: vi.fn(),
      rejectOnce: vi.fn(),
      timeoutHandle: setTimeout(() => undefined, 60_000),
    };

    try {
      (service as any).handleStreamJsonMessage(run, {
        type: 'assistant',
        content: [{ type: 'text', text: 'Late reply after relay completion.' }],
      });

      const live = service.getLiveLeadProcessMessages(teamName);
      expect(live).toHaveLength(1);
      expect(live[0].to).toBeUndefined();
      expect(live[0].text).toBe('Late reply after relay completion.');
      expect(live[0].source).toBe('lead_process');
    } finally {
      clearTimeout(run.leadRelayCapture.timeoutHandle);
      run.leadRelayCapture = null;
    }
  });

  it('does not show internal control echoes as late lead thoughts', () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    attachAliveRun(service, teamName);

    const run = (service as unknown as { runs: Map<string, unknown> }).runs.get('run-1') as {
      leadRelayCapture: null;
    };

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [
        {
          type: 'text',
          text: `Human: You have new inbox messages addressed to you (team lead "team-lead").
Process them in order (oldest first).
If action is required, delegate via task creation or SendMessage, and keep responses minimal.

Messages:
1) From: tom
   Timestamp: 2026-05-06T15:02:54.853Z
   Text:
   #f8d7235a done.`,
        },
      ],
    });

    expect(service.getLiveLeadProcessMessages(teamName)).toHaveLength(0);
  });

  it('adds substantive-only task comment guidance for lead relay prompts', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'alice',
        text: 'Automated task comment notification from @alice on #abcd1234 "Investigate":\n\n> Root cause found.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Comment on #abcd1234',
        source: 'system_notification',
        messageId: 'm-comment-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();

    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('Source: system_notification');
    expect(payload).toContain('summary looks like \\"Comment on #...\\"');
    expect(payload).toContain(
      'reply via task_add_comment only when you have a substantive board update'
    );
    expect(payload).toContain('Do NOT post acknowledgement-only task comments');

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Will reply on the task.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await relayPromise;
  });

  it('dedups by messageId even if markRead fails', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Ping leader',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Ping',
        messageId: 'm-1',
      },
    ]);

    hoisted.setAtomicWriteShouldFail(true);
    const { writeSpy } = attachAliveRun(service, teamName);

    const firstPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Acknowledged.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    const first = await firstPromise;
    const second = await service.relayLeadInboxMessages(teamName);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.appendSentMessage).not.toHaveBeenCalled();
    expect(service.getLiveLeadProcessMessages(teamName).map((message) => message.text)).toEqual([
      'Acknowledged.',
    ]);
  });

  it('does not mark as relayed when stdin is not writable', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Hello',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName, { writable: false });
    const first = await service.relayLeadInboxMessages(teamName);
    expect(first).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    (service as unknown as { runs: Map<string, unknown> }).runs.set('run-1', {
      runId: 'run-1',
      teamName,
      request: {
        teamName,
        members: [{ name: 'team-lead', role: 'team-lead' }],
      },
      activeToolCalls: new Map(),
      pendingToolCalls: [],
      leadMsgSeq: 0,
      pendingDirectCrossTeamSendRefresh: false,
      lastLeadTextEmitMs: 0,
      activeCrossTeamReplyHints: [],
      pendingInboxRelayCandidates: [],
      silentUserDmForward: null,
      silentUserDmForwardClearHandle: null,
      child: { stdin: { writable: true, write: writeSpy } },
      processKilled: false,
      cancelRequested: false,
      provisioningComplete: true,
      leadRelayCapture: null,
    });

    const secondPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Hi.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    const second = await secondPromise;
    expect(second).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let stale lead inbox relay work write into a newer run', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const inboxMessages = [
      {
        from: 'bob',
        text: 'Please pick this up.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-stale-lead-1',
      },
    ];
    seedConfig(teamName);
    seedLeadInbox(teamName, inboxMessages);

    const { writeSpy: oldWriteSpy, runId: oldRunId } = attachAliveRun(service, teamName, {
      runId: 'run-old',
    });
    const inboxDeferred = createDeferred<typeof inboxMessages>();
    const inboxReader = (
      service as unknown as {
        inboxReader: {
          getMessagesFor: (team: string, member: string) => Promise<typeof inboxMessages>;
        };
      }
    ).inboxReader;
    const inboxSpy = vi
      .spyOn(inboxReader, 'getMessagesFor')
      .mockImplementationOnce(async () => await inboxDeferred.promise)
      .mockImplementation(async () => inboxMessages);

    const relayPromise = service.relayLeadInboxMessages(teamName);
    await Promise.resolve();

    const oldRun = (service as unknown as { runs: Map<string, any> }).runs.get(oldRunId);
    oldRun.processKilled = true;
    oldRun.cancelRequested = true;
    oldRun.child.stdin.writable = false;

    const { writeSpy: newWriteSpy } = attachAliveRun(service, teamName, { runId: 'run-new' });
    inboxDeferred.resolve(inboxMessages);

    await expect(relayPromise).resolves.toBe(0);
    expect(oldWriteSpy).not.toHaveBeenCalled();
    expect(newWriteSpy).not.toHaveBeenCalled();
    inboxSpy.mockRestore();
  });

  it('does not let stale lead relay consume a newer run permission_request', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const permissionMessage = {
      from: 'alice',
      text: JSON.stringify({
        type: 'permission_request',
        request_id: 'perm-new-run-1',
        agent_id: 'alice',
        tool_name: 'Bash',
        input: { command: 'git status' },
      }),
      timestamp: '2026-02-23T10:00:30.000Z',
      read: false,
      messageId: 'perm-inbox-1',
    };
    seedConfig(teamName);
    seedLeadInbox(teamName, [permissionMessage]);

    const { runId: oldRunId } = attachAliveRun(service, teamName, { runId: 'run-old' });
    const inboxDeferred = createDeferred<[typeof permissionMessage]>();
    const inboxReader = (
      service as unknown as {
        inboxReader: {
          getMessagesFor: (team: string, member: string) => Promise<[typeof permissionMessage]>;
        };
      }
    ).inboxReader;
    const inboxSpy = vi
      .spyOn(inboxReader, 'getMessagesFor')
      .mockImplementationOnce(async () => await inboxDeferred.promise)
      .mockImplementation(async () => [permissionMessage]);

    const relayPromise = service.relayLeadInboxMessages(teamName);
    await Promise.resolve();

    const oldRun = (service as unknown as { runs: Map<string, any> }).runs.get(oldRunId);
    oldRun.processKilled = true;
    oldRun.cancelRequested = true;
    oldRun.child.stdin.writable = false;

    attachAliveRun(service, teamName, { runId: 'run-new' });
    inboxDeferred.resolve([permissionMessage]);

    await expect(relayPromise).resolves.toBe(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/team-lead.json`) ?? '[]'
    ) as Array<{ messageId?: string; read?: boolean }>;
    expect(inbox).toEqual([
      expect.objectContaining({
        messageId: 'perm-inbox-1',
        read: false,
      }),
    ]);
    expect(oldRun.pendingApprovals.size).toBe(0);
    expect(oldRun.processedPermissionRequestIds.size).toBe(0);
    inboxSpy.mockRestore();
  });

  it('relays legacy lead inbox rows with generated messageId', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Legacy row without id',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Ok.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    const relayed = await relayPromise;

    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves cross-team reply metadata only for a single matching team hint', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    attachAliveRun(service, teamName);

    const run = (service as unknown as { runs: Map<string, unknown> }).runs.get('run-1') as {
      activeCrossTeamReplyHints: Array<{ toTeam: string; conversationId: string }>;
    };
    run.activeCrossTeamReplyHints = [{ toTeam: 'other-team', conversationId: 'conv-1' }];

    expect(service.resolveCrossTeamReplyMetadata(teamName, 'other-team')).toEqual({
      conversationId: 'conv-1',
      replyToConversationId: 'conv-1',
    });

    run.activeCrossTeamReplyHints = [
      { toTeam: 'other-team', conversationId: 'conv-1' },
      { toTeam: 'other-team', conversationId: 'conv-2' },
    ];
    expect(service.resolveCrossTeamReplyMetadata(teamName, 'other-team')).toBeNull();
  });

  it('includes explicit cross-team reply instructions in lead relay prompts', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'other-team.team-lead',
        to: 'team-lead',
        text: '<cross-team from="other-team.team-lead" depth="0" conversationId="conv-explicit" />\nNeed your answer.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        source: 'cross_team',
        messageId: 'm-cross-team-explicit',
        conversationId: 'conv-explicit',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();

    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('Source: cross_team');
    expect(payload).toContain('Cross-team conversationId: conv-explicit');
    expect(payload).toContain(
      'Call the MCP tool named cross_team_send with toTeam=\\"other-team\\"'
    );
    expect(payload).toContain('replyToConversationId=\\"conv-explicit\\"');
    expect(payload).toContain('NEVER set recipient/to to \\"cross_team_send\\"');

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Replying properly.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    await relayPromise;
  });

  it('does not relay cross-team sender copies back into the live lead', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'user',
        to: 'other-team.team-lead',
        text: 'How is the progress on that task?',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        source: 'cross_team_sent',
        messageId: 'm-cross-team-sent-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const updatedInbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/team-lead.json`) ?? '[]'
    ) as Array<{ messageId?: string }>;
    expect(updatedInbox).toHaveLength(1);
    expect(updatedInbox[0]?.messageId).toBe('m-cross-team-sent-1');
  });

  it('does not relay returned cross-team replies back into the originating lead', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'user',
        to: 'other-team.team-lead',
        text: 'Original outbound request',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: true,
        source: 'cross_team_sent',
        messageId: 'm-cross-team-sent-1',
        conversationId: 'conv-1',
      },
      {
        from: 'other-team.team-lead',
        to: 'team-lead',
        text: '<cross-team from="other-team.team-lead" depth="0" conversationId="conv-1" replyToConversationId="conv-1" />\nReply back to origin.',
        timestamp: '2026-02-23T10:01:00.000Z',
        read: false,
        source: 'cross_team',
        messageId: 'm-cross-team-reply-1',
        conversationId: 'conv-1',
        replyToConversationId: 'conv-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const updatedInbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/team-lead.json`) ?? '[]'
    ) as Array<{ messageId?: string; read?: boolean }>;
    expect(updatedInbox).toHaveLength(2);
    expect(updatedInbox[1]?.messageId).toBe('m-cross-team-reply-1');
  });

  it('does not relay a fast first reply while outbound sender copy is still pending', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    service.registerPendingCrossTeamReplyExpectation(teamName, 'other-team', 'conv-race');
    seedLeadInbox(teamName, [
      {
        from: 'other-team.team-lead',
        to: 'team-lead',
        text: '<cross-team from="other-team.team-lead" depth="0" conversationId="conv-race" replyToConversationId="conv-race" />\nFast reply before sender copy.',
        timestamp: '2026-02-23T10:01:00.000Z',
        read: false,
        source: 'cross_team',
        messageId: 'm-cross-team-race-1',
        conversationId: 'conv-race',
        replyToConversationId: 'conv-race',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);
  });

  it('relays later follow-up messages after the first reply in a conversation was already received', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'user',
        to: 'other-team.team-lead',
        text: 'Original outbound request',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: true,
        source: 'cross_team_sent',
        messageId: 'm-cross-team-sent-2',
        conversationId: 'conv-followup',
      },
      {
        from: 'other-team.team-lead',
        to: 'team-lead',
        text: '<cross-team from="other-team.team-lead" depth="0" conversationId="conv-followup" replyToConversationId="conv-followup" />\nFirst answer.',
        timestamp: '2026-02-23T10:01:00.000Z',
        read: true,
        source: 'cross_team',
        messageId: 'm-cross-team-first-reply',
        conversationId: 'conv-followup',
        replyToConversationId: 'conv-followup',
      },
      {
        from: 'other-team.team-lead',
        to: 'team-lead',
        text: '<cross-team from="other-team.team-lead" depth="0" conversationId="conv-followup" replyToConversationId="conv-followup" />\nCan you confirm one more detail?',
        timestamp: '2026-02-23T10:02:00.000Z',
        read: false,
        source: 'cross_team',
        messageId: 'm-cross-team-followup',
        conversationId: 'conv-followup',
        replyToConversationId: 'conv-followup',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'I will answer the follow-up.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    const relayed = await relayPromise;
    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('relays unread teammate inbox messages through the live team process', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'team-lead',
        text: 'Comment on task #abcd1234 "Investigate":\n\nPlease retry with logging enabled.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Comment on #abcd1234',
        messageId: 'm-alice-1',
        source: 'system_notification',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('"type":"user"');
    expect(payload).toContain('to=\\"alice\\"');
    expect(payload).toContain('Source: system_notification');
    expect(payload).toContain('forward that notification exactly once without paraphrasing');
    expect(payload).toContain('Please retry with logging enabled.');
  });

  it('prioritizes member work-sync nudges over older ordinary member relay rows', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      ...Array.from({ length: 11 }, (_, index) => ({
        from: 'team-lead',
        text: `Routine relay row ${index + 1}.`,
        timestamp: `2026-02-23T10:${String(index).padStart(2, '0')}:00.000Z`,
        read: false,
        messageId: `m-ordinary-${index + 1}`,
      })),
      {
        from: 'system',
        text: 'Call member_work_sync_status, then member_work_sync_report.',
        timestamp: '2026-02-23T10:30:00.000Z',
        read: false,
        messageId: 'm-work-sync-late',
        messageKind: 'member_work_sync_nudge',
        workSyncIntent: 'agenda_sync',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(relayed).toBe(10);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('1) From: system');
    expect(payload).toContain('MessageId: m-work-sync-late');
    expect(payload).toContain('Message kind: member_work_sync_nudge');
    expect(payload).not.toContain('MessageId: m-ordinary-11');
  });

  it('keeps native member work-sync rows unread without accepted report proof', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    service.setMemberWorkSyncAcceptedReportChecker(async () => false);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'system',
        text: 'Call member_work_sync_status, then member_work_sync_report.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-work-sync-unproved',
        messageKind: 'member_work_sync_nudge',
        workSyncIntent: 'agenda_sync',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const firstRelayed = await service.relayMemberInboxMessages(teamName, 'alice');
    const rowsAfterFirst = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ read?: boolean }>;

    expect(firstRelayed).toBe(1);
    expect(rowsAfterFirst[0]?.read).toBe(false);

    const secondRelayed = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(secondRelayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it('read-commits native member work-sync rows after accepted report proof', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    service.setMemberWorkSyncAcceptedReportChecker(async () => true);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'system',
        text: 'Call member_work_sync_status, then member_work_sync_report.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-work-sync-proved',
        messageKind: 'member_work_sync_nudge',
        workSyncIntent: 'agenda_sync',
      },
    ]);

    attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ read?: boolean }>;

    expect(relayed).toBe(1);
    expect(rows[0]?.read).toBe(true);
    await expect(service.relayMemberInboxMessages(teamName, 'alice')).resolves.toBe(0);
  });

  it('retries a work-sync nudge after member relay times out before stdin write completes', async () => {
    vi.useFakeTimers();
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    try {
      seedConfig(teamName);
      seedMemberInbox(teamName, 'alice', [
        {
          from: 'system',
          text: 'Call member_work_sync_status, then member_work_sync_report.',
          timestamp: '2026-02-23T10:00:00.000Z',
          read: false,
          messageId: 'm-work-sync-retry',
          messageKind: 'member_work_sync_nudge',
          workSyncIntent: 'agenda_sync',
        },
      ]);

      const { writeSpy } = attachAliveRun(service, teamName);
      writeSpy.mockImplementationOnce(() => true);

      const firstRelay = service.relayMemberInboxMessages(teamName, 'alice');
      await vi.advanceTimersByTimeAsync(0);
      expect(writeSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(120_000);
      await expect(firstRelay).resolves.toBe(0);
      vi.mocked(console.warn).mockClear();

      const secondRelay = await service.relayMemberInboxMessages(teamName, 'alice');

      expect(secondRelay).toBe(1);
      expect(writeSpy).toHaveBeenCalledTimes(2);
      const secondPayload = String(writeSpy.mock.calls[1]?.[0] ?? '');
      expect(secondPayload).toContain('MessageId: m-work-sync-retry');
      expect(secondPayload).toContain('Message kind: member_work_sync_nudge');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks exact teammate relay copies with relayOfMessageId', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'team-lead',
        text:
          `**Comment on task #abcd1234**\n> Investigate\n\n> Please retry with logging enabled.\n\n` +
          '<agent-block>\nReply using task_add_comment\n</agent-block>',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Comment on #abcd1234',
        messageId: 'm-alice-1',
        source: 'system_notification',
      },
    ]);

    attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');
    expect(relayed).toBe(1);

    const run = (service as unknown as { runs: Map<string, unknown> }).runs.get('run-1') as unknown;
    expect(run).toBeTruthy();

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            recipient: 'alice',
            summary: 'Comment on #abcd1234',
            content:
              `**Comment on task #abcd1234**\n> Investigate\n\n> Please retry with logging enabled.\n\n` +
              '<agent-block>\nHidden internal instructions\n</agent-block>',
          },
        },
      ],
    });

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ messageId?: string; relayOfMessageId?: string; source?: string }>;
    const relayedCopy = inbox.find((row) => row.messageId?.startsWith('lead-sendmsg-run-1-'));
    expect(relayedCopy).toMatchObject({
      source: 'lead_process',
      relayOfMessageId: 'm-alice-1',
    });
  });

  it('does not capture user-dm silent forwards as extra lead_process messages', () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    attachAliveRun(service, teamName);

    const run = (service as unknown as { runs: Map<string, unknown> }).runs.get('run-1') as {
      silentUserDmForward: {
        target: string;
        startedAt: string;
        mode: 'user_dm' | 'member_inbox_relay';
      } | null;
    };
    run.silentUserDmForward = {
      target: 'alice',
      startedAt: new Date().toISOString(),
      mode: 'user_dm',
    };

    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            recipient: 'alice',
            summary: 'Forwarded DM',
            content: 'User DM payload',
          },
        },
      ],
    });

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ messageId?: string; source?: string }>;
    expect(inbox).toHaveLength(0);
  });

  it('does not relay pseudo cross-team member inboxes as teammates', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'cross-team:team-alpha-super', [
      {
        from: 'team-lead',
        text: 'Stale pseudo recipient inbox',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-pseudo-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'cross-team:team-alpha-super');

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);
  });

  it('does not relay tool-like cross-team inbox names as teammates', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'cross_team_send', [
      {
        from: 'team-lead',
        text: 'Wrongly routed tool recipient inbox',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-tool-recipient-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'cross_team_send');

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);
  });

  it('does not relay malformed underscore-style pseudo cross-team inbox names as teammates', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'cross_team::team-best', [
      {
        from: 'team-lead',
        text: 'Wrongly routed underscore pseudo inbox',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-underscore-pseudo-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'cross_team::team-best');

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);
  });

  it('includes user message provenance in lead inbox relay prompt', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'user',
        text: 'Build the authentication module',
        timestamp: '2026-02-23T14:00:00.000Z',
        read: false,
        summary: 'Auth module request',
        messageId: 'msg-provenance-001',
        source: 'user_sent',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Creating task.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    await relayPromise;

    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('Eligible for task_create_from_message: yes');
    expect(payload).toContain('User MessageId: msg-provenance-001');
    expect(payload).toContain('Build the authentication module');
  });

  it('includes MessageId in member inbox relay prompt for provenance', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'bob',
        text: 'Please review my changes',
        timestamp: '2026-02-23T15:00:00.000Z',
        read: false,
        summary: 'Review request',
        messageId: 'msg-member-relay-001',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    await service.relayMemberInboxMessages(teamName, 'alice');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('MessageId: msg-member-relay-001');
    expect(payload).toContain('Please review my changes');
  });

  it('does not let stale member inbox relay work write into a newer run', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const inboxMessages = [
      {
        from: 'user',
        text: 'Please sync with Alice.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-stale-member-1',
      },
    ];
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', inboxMessages);

    const { writeSpy: oldWriteSpy, runId: oldRunId } = attachAliveRun(service, teamName, {
      runId: 'run-old',
    });
    const inboxDeferred = createDeferred<typeof inboxMessages>();
    const inboxReader = (
      service as unknown as {
        inboxReader: {
          getMessagesFor: (team: string, member: string) => Promise<typeof inboxMessages>;
        };
      }
    ).inboxReader;
    const inboxSpy = vi
      .spyOn(inboxReader, 'getMessagesFor')
      .mockImplementationOnce(async () => await inboxDeferred.promise)
      .mockImplementation(async () => inboxMessages);

    const relayPromise = service.relayMemberInboxMessages(teamName, 'alice');
    await Promise.resolve();

    const oldRun = (service as unknown as { runs: Map<string, any> }).runs.get(oldRunId);
    oldRun.processKilled = true;
    oldRun.cancelRequested = true;
    oldRun.child.stdin.writable = false;

    const { writeSpy: newWriteSpy } = attachAliveRun(service, teamName, { runId: 'run-new' });
    inboxDeferred.resolve(inboxMessages);

    await expect(relayPromise).resolves.toBe(0);
    expect(oldWriteSpy).not.toHaveBeenCalled();
    expect(newWriteSpy).not.toHaveBeenCalled();
    inboxSpy.mockRestore();
  });

  it('marks pure member heartbeat idle as read without relaying it', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
        }),
        timestamp: '2026-02-23T15:10:00.000Z',
        read: false,
        messageId: 'idle-member-heartbeat-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ messageId?: string; read?: boolean }>;
    expect(inbox).toEqual([
      expect.objectContaining({
        messageId: 'idle-member-heartbeat-1',
        read: true,
      }),
    ]);
  });

  it('marks member heartbeat with peer summary read and does not relay it', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T15:11:00.000Z',
        read: false,
        messageId: 'idle-member-summary-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const first = await service.relayMemberInboxMessages(teamName, 'alice');
    const second = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ messageId?: string; read?: boolean }>;
    expect(inbox).toEqual([
      expect.objectContaining({
        messageId: 'idle-member-summary-1',
        read: true,
      }),
    ]);
  });

  it('marks legacy member passive idle rows read via fallback identity', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T15:11:30.000Z',
        read: false,
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ read?: boolean }>;
    expect(inbox).toEqual([expect.objectContaining({ read: true })]);
  });

  it('marks byte-identical legacy member passive idle duplicates read together', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    const duplicate = {
      from: 'alice',
      text: JSON.stringify({
        type: 'idle_notification',
        idleReason: 'available',
        summary: '[to bob] aligned on rollout order',
      }),
      timestamp: '2026-02-23T15:11:31.000Z',
      read: false,
    };
    seedMemberInbox(teamName, 'alice', [duplicate, { ...duplicate }]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ read?: boolean }>;
    expect(inbox).toEqual([
      expect.objectContaining({ read: true }),
      expect.objectContaining({ read: true }),
    ]);
  });

  it('retries passive member idle on next cycle when exact mark-read fails', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T15:11:45.000Z',
        read: false,
        messageId: 'idle-member-summary-fail-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    hoisted.setAtomicWriteShouldFail(true);
    const first = await service.relayMemberInboxMessages(teamName, 'alice');
    hoisted.setAtomicWriteShouldFail(false);
    const second = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ messageId?: string; read?: boolean }>;
    expect(inbox).toEqual([
      expect.objectContaining({
        messageId: 'idle-member-summary-fail-1',
        read: true,
      }),
    ]);
  });

  it('does not rewrite the inbox file when exact mark-read is a no-op on an already-read legacy row', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const legacyRow = {
      from: 'alice',
      text: JSON.stringify({
        type: 'idle_notification',
        idleReason: 'available',
        summary: '[to bob] aligned on rollout order',
      }),
      timestamp: '2026-02-23T15:11:46.000Z',
      read: true,
    };
    seedMemberInbox(teamName, 'alice', [legacyRow]);

    await (service as any).markInboxMessagesRead(teamName, 'alice', [
      {
        messageId: buildLegacyInboxMessageId(legacyRow.from, legacyRow.timestamp, legacyRow.text),
      },
    ]);

    expect(hoisted.atomicWrite).not.toHaveBeenCalled();
  });

  it('marks persisted duplicate messageId passive rows read together', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T15:11:47.000Z',
        read: false,
        messageId: 'dup-passive-id-1',
      },
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T15:11:48.000Z',
        read: false,
        messageId: 'dup-passive-id-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/alice.json`) ?? '[]'
    ) as Array<{ messageId?: string; read?: boolean }>;
    expect(inbox).toEqual([
      expect.objectContaining({ messageId: 'dup-passive-id-1', read: true }),
      expect.objectContaining({ messageId: 'dup-passive-id-1', read: true }),
    ]);
  });

  it('relays actionable member idle notifications such as failures', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedMemberInbox(teamName, 'alice', [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'failed',
          completedStatus: 'failed',
          failureReason: 'teammate crashed',
        }),
        timestamp: '2026-02-23T15:12:00.000Z',
        read: false,
        messageId: 'idle-member-failure-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayMemberInboxMessages(teamName, 'alice');

    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('idle_notification');
    expect(payload).toContain('teammate crashed');
  });

  it('lead inbox relay prompt mentions task_create_from_message for user messages with messageId', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: 'My Team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', role: 'developer' },
        ],
      })
    );
    seedLeadInbox(teamName, [
      {
        from: 'user',
        text: 'Implement dark mode',
        timestamp: '2026-02-23T16:00:00.000Z',
        read: false,
        summary: 'Dark mode',
        messageId: 'msg-task-pref-001',
        source: 'user_sent',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Got it.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    await relayPromise;

    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('task_create_from_message');
    expect(payload).toContain('Current durable team context:');
    expect(payload).toContain(`- Team name: ${teamName}`);
    expect(payload).toContain(`teamName MUST be \\"${teamName}\\"`);
    expect(payload).toContain('Eligible for task_create_from_message: yes');
    expect(payload).toContain('User MessageId: msg-task-pref-001');
  });

  it('does not present teammate inbox message ids as task_create_from_message provenance', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'jack',
        text: 'Могу начать с проверки массовых удалений в docs-site.',
        timestamp: '2026-02-23T16:05:00.000Z',
        read: false,
        summary: 'Нет назначенных задач для jack',
        messageId: 'inbox-jack-001',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Понял.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    await relayPromise;

    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('Eligible for task_create_from_message: no');
    expect(payload).not.toContain('User MessageId: inbox-jack-001');
  });

  it('marks pure lead heartbeat idle as read without relaying it', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
        }),
        timestamp: '2026-02-23T16:10:00.000Z',
        read: false,
        messageId: 'idle-lead-heartbeat-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/team-lead.json`) ?? '[]'
    ) as Array<{ messageId?: string; read?: boolean }>;
    expect(inbox).toEqual([
      expect.objectContaining({
        messageId: 'idle-lead-heartbeat-1',
        read: true,
      }),
    ]);
  });

  it('marks lead heartbeat with peer summary read across repeated scans and does not relay it', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T16:11:00.000Z',
        read: false,
        messageId: 'idle-lead-summary-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);

    const first = await service.relayLeadInboxMessages(teamName);
    const second = await service.relayLeadInboxMessages(teamName);

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    const inbox = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/team-lead.json`) ?? '[]'
    ) as Array<{ messageId?: string; read?: boolean }>;
    expect(inbox).toEqual([
      expect.objectContaining({
        messageId: 'idle-lead-summary-1',
        read: true,
      }),
    ]);
  });

  it('does not clear pending cross-team reply expectations for passive lead idle', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    service.registerPendingCrossTeamReplyExpectation(teamName, 'other-team', 'conv-passive');
    seedLeadInbox(teamName, [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T16:11:30.000Z',
        read: false,
        messageId: 'idle-lead-summary-2',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);
    const pendingKeys = (service as any).getPendingCrossTeamReplyExpectationKeys(teamName);
    expect(Array.from(pendingKeys)).toContain('other-team\0conv-passive');
  });

  it('does not feed passive lead idle into same-team native matching', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T16:11:45.000Z',
        read: false,
        messageId: 'idle-lead-summary-native-match-1',
      },
    ]);

    const nativeMatchSpy = vi
      .spyOn((service as any).leadInboxRelayFacade, 'confirmSameTeamNativeMatches')
      .mockResolvedValue({ nativeMatchedMessageIds: new Set<string>(), persisted: true });

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);
    expect(nativeMatchSpy).toHaveBeenCalledWith(teamName, 'team-lead', []);
  });

  it('keeps same-team native matches retryable when persisting read state fails', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    const now = Date.now();
    seedLeadInbox(teamName, [
      {
        from: 'alice',
        to: 'team-lead',
        text: 'Native delivered update',
        summary: 'native update',
        timestamp: new Date(now).toISOString(),
        read: false,
        messageId: 'same-team-native-persist-failed-1',
      },
    ]);
    (service as any).recentSameTeamNativeFingerprints.set(teamName, [
      {
        id: 'fingerprint-1',
        from: 'alice',
        text: 'Native delivered update',
        summary: 'native update',
        seenAt: now,
      },
    ]);
    vi.spyOn(service as any, 'markInboxMessagesRead').mockRejectedValue(new Error('write failed'));

    await (service as any).leadInboxRelayFacade.reconcileSameTeamNativeDeliveries(
      teamName,
      'team-lead'
    );

    expect((service as any).relayedLeadInboxMessageIds.has(teamName)).toBe(false);
    expect((service as any).recentSameTeamNativeFingerprints.get(teamName)).toEqual([
      expect.objectContaining({ id: 'fingerprint-1' }),
    ]);
    expect((service as any).pendingTimeouts.has(`same-team-persist:${teamName}`)).toBe(true);
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/team-lead.json`) ?? '[]'
    );
    expect(rows[0].read).toBe(false);

    const retryTimer = (service as any).pendingTimeouts.get(`same-team-persist:${teamName}`);
    clearTimeout(retryTimer);
    (service as any).pendingTimeouts.delete(`same-team-persist:${teamName}`);
  });

  it('does not let cross-team idle-shaped payloads inherit passive idle handling', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'other-team.alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
        timestamp: '2026-02-23T16:11:50.000Z',
        read: false,
        messageId: 'cross-team-idle-shaped-1',
        source: 'cross_team',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Seen.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    const relayed = await relayPromise;
    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('relays actionable lead idle notifications such as task-terminal updates', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          completedTaskId: 'task-1',
          completedStatus: 'blocked',
        }),
        timestamp: '2026-02-23T16:12:00.000Z',
        read: false,
        messageId: 'idle-lead-terminal-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Investigating blocker.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    const relayed = await relayPromise;
    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('idle_notification');
    expect(payload).toContain('blocked');
  });

  it('relays unread OpenCode member inbox rows to the runtime before marking them read', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/mock/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Please review this.',
        timestamp: '2026-02-23T17:00:00.000Z',
        read: false,
        messageId: 'opencode-relay-1',
        taskRefs: [{ teamName, taskId: 'task-1', displayId: 'abcd1234' }],
        actionMode: 'ask',
      },
    ]);
    const deliverSpy = vi
      .spyOn(service, 'deliverOpenCodeMemberMessage')
      .mockResolvedValue({ delivered: true, diagnostics: [] });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(relay).toMatchObject({ relayed: 1, attempted: 1, delivered: 1, failed: 0 });
    expect(deliverSpy).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({
        memberName: 'jack',
        text: 'Please review this.',
        messageId: 'opencode-relay-1',
        replyRecipient: 'bob',
        actionMode: 'ask',
        taskRefs: [{ teamName, taskId: 'task-1', displayId: 'abcd1234' }],
      })
    );
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows[0].read).toBe(true);
  });

  it('uses inferred task refs when relaying legacy OpenCode inbox rows without structured refs', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const taskRefs = [{ teamName, taskId: 'task-1', displayId: 'abcd1234' }];
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/mock/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'team-lead',
        to: 'jack',
        text: '**Comment on task #abcd1234**\n\nPlease continue.',
        timestamp: '2026-02-23T17:00:00.000Z',
        read: false,
        messageId: 'opencode-relay-infer-1',
        summary: 'Comment on #abcd1234',
      },
    ]);
    const inferMock = vi
      .mocked(inferOpenCodeInboxMessageTaskRefs)
      .mockResolvedValueOnce(taskRefs);
    const deliverSpy = vi
      .spyOn(service, 'deliverOpenCodeMemberMessage')
      .mockResolvedValue({ delivered: true, diagnostics: [] });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(relay).toMatchObject({ relayed: 1, attempted: 1, delivered: 1, failed: 0 });
    expect(inferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName,
        message: expect.objectContaining({ messageId: 'opencode-relay-infer-1' }),
        readTasks: expect.any(Function),
      })
    );
    expect(deliverSpy).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({
        messageId: 'opencode-relay-infer-1',
        taskRefs,
      })
    );
  });

  it('keeps OpenCode member inbox rows unread while runtime response is pending', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Please answer this.',
        timestamp: '2026-02-23T17:00:00.000Z',
        read: false,
        messageId: 'opencode-response-pending-1',
        actionMode: 'ask',
      },
    ]);
    vi.spyOn(service, 'deliverOpenCodeMemberMessage').mockResolvedValue({
      delivered: true,
      accepted: true,
      responsePending: true,
      responseState: 'pending',
      diagnostics: ['opencode_delivery_response_pending'],
    });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(relay).toMatchObject({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 0,
      lastDelivery: { delivered: true, responsePending: true },
    });
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows[0].read).toBe(false);
  });

  it('keeps accepted OpenCode prompt rows pending without warning when response proof is terminally absent', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Please sync your current task.',
        timestamp: '2026-02-23T17:04:00.000Z',
        read: false,
        messageId: 'opencode-accepted-terminal-empty-1',
        actionMode: 'do',
        messageKind: 'member_work_sync_nudge',
      },
    ]);
    vi.spyOn(service, 'deliverOpenCodeMemberMessage').mockResolvedValue({
      delivered: false,
      accepted: true,
      responsePending: false,
      responseState: 'empty_assistant_turn',
      ledgerStatus: 'failed_terminal',
      ledgerRecordId: 'ledger-1',
      laneId: 'secondary:opencode:jack',
      reason: 'empty_assistant_turn',
      diagnostics: ['empty_assistant_turn'],
    });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(relay).toMatchObject({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 0,
      lastDelivery: {
        delivered: false,
        accepted: true,
        responsePending: false,
        ledgerStatus: 'failed_terminal',
        reason: 'empty_assistant_turn',
      },
    });
    expect(vi.mocked(console.warn)).not.toHaveBeenCalledWith(
      expect.stringContaining('OpenCode inbox relay failed')
    );
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows[0].read).toBe(false);
  });

  it('does not treat empty OpenCode observations as accepted without delivered prompt proof', () => {
    const isAccepted = (observation?: unknown) =>
      isOpenCodePromptAcceptedByObservation(observation as any);

    expect(
      isAccepted({
        state: 'empty_assistant_turn',
        deliveredUserMessageId: null,
      })
    ).toBe(false);
    expect(
      isAccepted({
        state: 'prompt_delivered_no_assistant_message',
        deliveredUserMessageId: '',
      })
    ).toBe(false);
    expect(
      isAccepted({
        state: 'empty_assistant_turn',
        deliveredUserMessageId: 'opencode-user-message-1',
      })
    ).toBe(true);
  });

  it('reuses existing OpenCode prompt ledger metadata during watchdog relay retries', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const taskRefs = [{ teamName, taskId: 'task-1', displayId: 'abcd1234' }];
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Please answer the app user.',
        timestamp: '2026-02-23T17:00:00.000Z',
        read: false,
        messageId: 'opencode-ledger-metadata-1',
        actionMode: 'ask',
      },
    ]);
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getByInboxMessage: vi.fn(async () => ({
        id: 'record-1',
        status: 'retry_scheduled',
        replyRecipient: 'user',
        actionMode: 'delegate',
        taskRefs,
        source: 'manual',
      })),
    });
    const deliverSpy = vi.spyOn(service, 'deliverOpenCodeMemberMessage').mockResolvedValue({
      delivered: true,
      accepted: true,
      responsePending: true,
      responseState: 'pending',
      diagnostics: ['opencode_delivery_response_pending'],
    });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack', {
      onlyMessageId: 'opencode-ledger-metadata-1',
      source: 'watchdog',
    });

    expect(relay).toMatchObject({
      attempted: 1,
      delivered: 0,
      failed: 0,
      lastDelivery: { delivered: true, responsePending: true },
    });
    expect(deliverSpy).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({
        messageId: 'opencode-ledger-metadata-1',
        replyRecipient: 'user',
        actionMode: 'delegate',
        taskRefs,
        source: 'manual',
      })
    );
  });

  it('records and schedules a retry when the OpenCode bridge throws during prompt delivery', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    const sendMessageToMember = vi.fn(async () => {
      throw new Error('bridge crashed');
    });
    service.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([
        {
          providerId: 'opencode',
          prepare: vi.fn(),
          launch: vi.fn(),
          reconcile: vi.fn(),
          stop: vi.fn(),
          sendMessageToMember,
        } as any,
      ])
    );
    (service as any).setSecondaryRuntimeRun({
      teamName,
      runId: 'opencode-run-1',
      providerId: 'opencode',
      laneId,
      memberName: 'jack',
      cwd: '/tmp/my-team',
    });
    vi.spyOn(service as any, 'getCurrentOpenCodeRuntimeRunId').mockReturnValue('opencode-run-1');
    vi.spyOn(
      OpenCodeRuntimeStore,
      'readCommittedOpenCodeBootstrapSessionEvidence'
    ).mockResolvedValue({
      state: 'healthy',
      committed: true,
      activeRunId: 'opencode-run-1',
      sessions: [
        {
          id: 'session-jack',
          teamName,
          memberName: 'jack',
          laneId,
          runId: 'opencode-run-1',
          observedAt: '2026-02-23T17:00:00.000Z',
          source: 'runtime_bootstrap_checkin',
        },
      ],
      diagnostics: [],
    });
    const watchdogSpy = vi
      .spyOn(service as any, 'scheduleOpenCodePromptDeliveryWatchdog')
      .mockImplementation(() => undefined);
    const records: any[] = [];
    const ledger = {
      getActiveForMember: vi.fn(async () => null),
      ensurePending: vi.fn(async (input: Record<string, unknown>) => {
        const record = {
          id: 'ledger-send-exception-1',
          teamName,
          memberName: 'jack',
          laneId,
          runId: 'opencode-run-1',
          runtimeSessionId: null,
          runtimePromptMessageId: null,
          runtimePromptMessageIds: [],
          lastRuntimePromptMessageId: null,
          lastDeliveryAttemptIdWithAcceptedPrompt: null,
          inboxMessageId: 'opencode-send-exception-1',
          inboxTimestamp: '2026-02-23T17:00:00.000Z',
          source: 'watcher',
          messageKind: 'default',
          workSyncIntent: null,
          replyRecipient: 'team-lead',
          actionMode: 'do',
          taskRefs: [],
          payloadHash: 'sha256:test',
          status: 'pending',
          responseState: 'not_observed',
          attempts: 0,
          maxAttempts: 3,
          acceptanceUnknown: false,
          nextAttemptAt: null,
          lastAttemptAt: null,
          lastObservedAt: null,
          acceptedAt: null,
          respondedAt: null,
          failedAt: null,
          inboxReadCommittedAt: null,
          inboxReadCommitError: null,
          prePromptCursor: null,
          postPromptCursor: null,
          deliveredUserMessageId: null,
          observedAssistantMessageId: null,
          observedAssistantPreview: null,
          observedToolCallNames: [],
          observedVisibleMessageId: null,
          visibleReplyMessageId: null,
          visibleReplyInbox: null,
          visibleReplyCorrelation: null,
          lastReason: null,
          diagnostics: [] as string[],
          createdAt: '2026-02-23T17:00:00.000Z',
          updatedAt: '2026-02-23T17:00:00.000Z',
          ...input,
        };
        records.push(record);
        return record;
      }),
      applyDeliveryResult: vi.fn(async (input: Record<string, unknown>) => {
        const record = records[0];
        Object.assign(record, {
          status: 'failed_retryable',
          responseState: 'reconcile_failed',
          attempts: 1,
          lastAttemptAt: input.now,
          lastReason: input.reason,
          diagnostics: input.diagnostics,
          updatedAt: input.now,
        });
        return record;
      }),
      markNextAttemptScheduled: vi.fn(async (input: Record<string, unknown>) => {
        const record = records[0];
        Object.assign(record, {
          status: input.status,
          nextAttemptAt: input.nextAttemptAt,
          lastReason: input.reason,
          updatedAt: input.scheduledAt,
        });
        return record;
      }),
      markFailedTerminal: vi.fn(),
    };
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue(ledger);

    const delivery = await service.deliverOpenCodeMemberMessage(teamName, {
      memberName: 'jack',
      text: 'Please continue task.',
      messageId: 'opencode-send-exception-1',
      source: 'watcher',
      replyRecipient: 'team-lead',
      actionMode: 'do',
      inboxTimestamp: '2026-02-23T17:00:00.000Z',
    });

    expect(sendMessageToMember).toHaveBeenCalledTimes(1);
    expect(ledger.applyDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        accepted: false,
        attempted: true,
        reason: expect.stringContaining('bridge crashed'),
      })
    );
    expect(ledger.markNextAttemptScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'retry_scheduled',
        reason: expect.stringContaining('bridge crashed'),
      })
    );
    expect(watchdogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName,
        memberName: 'jack',
        messageId: 'opencode-send-exception-1',
      })
    );
    expect(delivery).toMatchObject({
      delivered: false,
      accepted: false,
      responsePending: true,
      ledgerStatus: 'retry_scheduled',
      ledgerRecordId: 'ledger-send-exception-1',
      reason: expect.stringContaining('bridge crashed'),
    });
  });

  it('does not postpone an earlier OpenCode prompt watchdog wake when rescheduled later', async () => {
    vi.useFakeTimers();
    try {
      const service = new TeamProvisioningService();
      const relaySpy = vi
        .spyOn(service, 'relayOpenCodeMemberInboxMessages')
        .mockResolvedValue({ attempted: 1, delivered: 0, failed: 0 } as any);
      vi.spyOn(service as any, 'canDeliverToOpenCodeRuntimeForTeam').mockReturnValue(true);

      (service as any).scheduleOpenCodePromptDeliveryWatchdog({
        teamName: 'my-team',
        memberName: 'jack',
        messageId: 'message-1',
        delayMs: 500,
      });
      (service as any).scheduleOpenCodePromptDeliveryWatchdog({
        teamName: 'my-team',
        memberName: 'jack',
        messageId: 'message-1',
        delayMs: 60_000,
      });

      await vi.advanceTimersByTimeAsync(501);

      expect(relaySpy).toHaveBeenCalledTimes(1);
      expect(relaySpy).toHaveBeenCalledWith('my-team', 'jack', {
        onlyMessageId: 'message-1',
        source: 'watchdog',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale OpenCode watchdog jobs after the runtime lane is no longer active', async () => {
    vi.useFakeTimers();
    try {
      const service = new TeamProvisioningService();
      const teamName = 'my-team';
      hoisted.files.set(
        `/mock/teams/${teamName}/config.json`,
        JSON.stringify({
          name: teamName,
          projectPath: '/tmp/my-team',
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
          ],
        })
      );
      seedMemberInbox(teamName, 'jack', [
        {
          from: 'bob',
          to: 'jack',
          text: 'Please sync.',
          timestamp: '2026-02-23T17:00:00.000Z',
          read: false,
          messageId: 'opencode-stale-watchdog-1',
        },
      ]);
      const deliverSpy = vi
        .spyOn(service, 'deliverOpenCodeMemberMessage')
        .mockRejectedValue(
          new Error('OpenCode prompt delivery record not found: opencode-prompt:stale')
        );

      (service as any).scheduleOpenCodePromptDeliveryWatchdog({
        teamName,
        memberName: 'jack',
        messageId: 'opencode-stale-watchdog-1',
        delayMs: 500,
      });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();

      expect(deliverSpy).not.toHaveBeenCalled();
      expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips failed-terminal OpenCode rows without blocking newer unread rows', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    const identity = await (service as any).resolveOpenCodeMemberDeliveryIdentity(teamName, 'jack');
    expect(identity.ok).toBe(true);
    const failedRecord = {
      id: 'ledger-terminal-old',
      status: 'failed_terminal',
      inboxMessageId: 'opencode-terminal-old',
      lastReason: 'opencode_attachments_not_supported_for_secondary_runtime',
      diagnostics: ['opencode_attachments_not_supported_for_secondary_runtime'],
    };
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getByInboxMessage: vi.fn(async (input: { inboxMessageId: string }) =>
        input.inboxMessageId === 'opencode-terminal-old' ? failedRecord : null
      ),
    });
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Old terminal row.',
        timestamp: '2026-02-23T17:00:00.000Z',
        read: false,
        messageId: 'opencode-terminal-old',
      },
      {
        from: 'bob',
        to: 'jack',
        text: 'New deliverable row.',
        timestamp: '2026-02-23T17:00:02.000Z',
        read: false,
        messageId: 'opencode-terminal-new',
      },
    ]);
    const deliverSpy = vi
      .spyOn(service, 'deliverOpenCodeMemberMessage')
      .mockResolvedValue({ delivered: true, diagnostics: [] });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(relay).toMatchObject({ relayed: 1, attempted: 1, delivered: 1, failed: 0 });
    expect(relay.diagnostics?.join('\n')).toContain(
      'opencode_attachments_not_supported_for_secondary_runtime'
    );
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({ messageId: 'opencode-terminal-new' })
    );
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows.map((row: { read?: boolean }) => row.read)).toEqual([false, true]);
  });

  it('emits advisory refresh when a failed-terminal OpenCode row is recovered by visible reply proof', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const taskRefs = [{ teamName, taskId: 'task-recovered', displayId: 'task-rec' }];
    const ledgerRecord = {
      id: 'ledger-terminal-recovered',
      teamName,
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      runId: 'run-1',
      runtimeSessionId: 'ses-1',
      inboxMessageId: 'opencode-terminal-recovered',
      inboxTimestamp: '2026-02-23T17:00:00.000Z',
      source: 'watcher',
      messageKind: null,
      replyRecipient: 'team-lead',
      actionMode: null,
      taskRefs,
      payloadHash: 'sha256:test',
      status: 'failed_terminal',
      responseState: 'session_stale',
      attempts: 1,
      maxAttempts: 3,
      acceptanceUnknown: false,
      nextAttemptAt: null,
      lastAttemptAt: '2026-02-23T17:00:03.000Z',
      lastObservedAt: '2026-02-23T17:00:05.000Z',
      acceptedAt: '2026-02-23T17:00:03.000Z',
      respondedAt: null,
      failedAt: '2026-02-23T17:00:08.000Z',
      inboxReadCommittedAt: null,
      inboxReadCommitError: null,
      prePromptCursor: null,
      postPromptCursor: null,
      deliveredUserMessageId: 'runtime-user-1',
      observedAssistantMessageId: null,
      observedAssistantPreview: null,
      observedToolCallNames: [],
      observedVisibleMessageId: null,
      visibleReplyMessageId: null,
      visibleReplyInbox: null,
      visibleReplyCorrelation: null,
      lastReason: 'opencode_session_stale_observe_loop_after_accepted_prompt',
      diagnostics: ['opencode_session_stale_observe_loop_after_accepted_prompt'],
      createdAt: '2026-02-23T17:00:00.000Z',
      updatedAt: '2026-02-23T17:00:08.000Z',
    };
    const visibleReply = {
      inboxName: 'team-lead',
      message: {
        from: 'jack',
        to: 'team-lead',
        text: 'Recovered visible reply with task results.',
        summary: '#task-rec done',
        timestamp: '2026-02-23T17:01:00.000Z',
        read: true,
        source: 'runtime_delivery',
        relayOfMessageId: 'opencode-terminal-recovered',
        messageId: 'visible-reply-recovered',
        taskRefs,
      },
    };
    const proofService = (service as any).openCodeVisibleReplyProofService;
    vi.spyOn(proofService, 'findByRelayOfMessageId').mockResolvedValue(visibleReply);
    const applyDestinationProof = vi.fn(async (input: Record<string, unknown>) => ({
      ...ledgerRecord,
      status: 'responded',
      responseState: 'responded_visible_message',
      failedAt: null,
      lastReason: null,
      visibleReplyInbox: input.visibleReplyInbox,
      visibleReplyMessageId: input.visibleReplyMessageId,
      visibleReplyCorrelation: input.visibleReplyCorrelation,
      inboxReadCommittedAt: '2026-02-23T17:01:01.000Z',
      respondedAt: input.observedAt,
      updatedAt: input.observedAt,
    }));
    const advisoryInvalidator = vi.fn();
    const teamChangeEmitter = vi.fn();
    service.setMemberRuntimeAdvisoryInvalidator(advisoryInvalidator);
    service.setTeamChangeEmitter(teamChangeEmitter);

    const result = await proofService.applyDestinationProof({
      ledger: { applyDestinationProof },
      ledgerRecord,
      teamName,
      replyRecipient: 'team-lead',
      memberName: 'jack',
    });

    expect(result.visibleReply).toBe(visibleReply);
    expect(result.ledgerRecord.status).toBe('responded');
    expect(applyDestinationProof).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ledger-terminal-recovered',
        visibleReplyInbox: 'team-lead',
        visibleReplyMessageId: 'visible-reply-recovered',
        visibleReplyCorrelation: 'relayOfMessageId',
        semanticallySufficient: true,
      })
    );
    expect(advisoryInvalidator).toHaveBeenCalledWith(teamName, 'jack');
    expect(teamChangeEmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'member-advisory',
        teamName,
        detail: 'runtime-delivery-reply:jack:opencode-terminal-recovered',
      })
    );
  });

  it('does not emit advisory refresh again for already proven OpenCode visible replies', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const ledgerRecord = {
      id: 'ledger-already-proven',
      teamName,
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      runId: 'run-1',
      runtimeSessionId: 'ses-1',
      inboxMessageId: 'opencode-already-proven',
      inboxTimestamp: '2026-02-23T17:00:00.000Z',
      source: 'watcher',
      messageKind: null,
      replyRecipient: 'team-lead',
      actionMode: null,
      taskRefs: [],
      payloadHash: 'sha256:test',
      status: 'responded',
      responseState: 'responded_visible_message',
      attempts: 1,
      maxAttempts: 3,
      acceptanceUnknown: false,
      nextAttemptAt: null,
      lastAttemptAt: '2026-02-23T17:00:03.000Z',
      lastObservedAt: '2026-02-23T17:01:00.000Z',
      acceptedAt: '2026-02-23T17:00:03.000Z',
      respondedAt: '2026-02-23T17:01:00.000Z',
      failedAt: null,
      inboxReadCommittedAt: '2026-02-23T17:01:01.000Z',
      inboxReadCommitError: null,
      prePromptCursor: null,
      postPromptCursor: null,
      deliveredUserMessageId: 'runtime-user-1',
      observedAssistantMessageId: null,
      observedAssistantPreview: null,
      observedToolCallNames: [],
      observedVisibleMessageId: null,
      visibleReplyMessageId: 'visible-reply-proven',
      visibleReplyInbox: 'team-lead',
      visibleReplyCorrelation: 'relayOfMessageId',
      lastReason: null,
      diagnostics: [],
      createdAt: '2026-02-23T17:00:00.000Z',
      updatedAt: '2026-02-23T17:01:01.000Z',
    };
    const visibleReply = {
      inboxName: 'team-lead',
      message: {
        from: 'jack',
        to: 'team-lead',
        text: 'Already proven visible reply.',
        summary: '#done',
        timestamp: '2026-02-23T17:01:00.000Z',
        read: true,
        source: 'runtime_delivery',
        relayOfMessageId: 'opencode-already-proven',
        messageId: 'visible-reply-proven',
      },
    };
    const proofService = (service as any).openCodeVisibleReplyProofService;
    vi.spyOn(proofService, 'findByRelayOfMessageId').mockResolvedValue(visibleReply);
    const applyDestinationProof = vi.fn(async () => ledgerRecord);
    const advisoryInvalidator = vi.fn();
    const teamChangeEmitter = vi.fn();
    service.setMemberRuntimeAdvisoryInvalidator(advisoryInvalidator);
    service.setTeamChangeEmitter(teamChangeEmitter);

    const result = await proofService.applyDestinationProof({
      ledger: { applyDestinationProof },
      ledgerRecord,
      teamName,
      replyRecipient: 'team-lead',
      memberName: 'jack',
    });

    expect(result.visibleReply).toBe(visibleReply);
    expect(applyDestinationProof).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ledger-already-proven',
        visibleReplyMessageId: 'visible-reply-proven',
        semanticallySufficient: true,
      })
    );
    expect(advisoryInvalidator).not.toHaveBeenCalled();
    expect(teamChangeEmitter).not.toHaveBeenCalled();
  });

  it('retries failed-terminal OpenCode rows caused by stale runtime manifest watermark', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    const identity = await (service as any).resolveOpenCodeMemberDeliveryIdentity(teamName, 'jack');
    expect(identity.ok).toBe(true);
    const staleRecord = {
      id: 'ledger-terminal-stale-manifest',
      teamName,
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      runId: 'run-1',
      status: 'failed_terminal',
      responseState: 'reconcile_failed',
      attempts: 3,
      maxAttempts: 3,
      inboxMessageId: 'opencode-terminal-stale-manifest',
      replyRecipient: 'team-lead',
      actionMode: null,
      taskRefs: [],
      source: 'watcher',
      lastReason:
        'opencode_message_delivery_exception: Bridge server runtime manifest high watermark is stale',
      diagnostics: [
        'opencode_message_delivery_exception: Bridge server runtime manifest high watermark is stale',
      ],
    };
    const markNextAttemptScheduled = vi.fn(async (input: Record<string, unknown>) => ({
      ...staleRecord,
      status: input.status,
      nextAttemptAt: input.nextAttemptAt,
      lastReason: input.reason,
    }));
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getByInboxMessage: vi.fn(async (input: { inboxMessageId: string }) =>
        input.inboxMessageId === 'opencode-terminal-stale-manifest' ? staleRecord : null
      ),
      markNextAttemptScheduled,
    });
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Old stale manifest row.',
        timestamp: '2026-02-23T17:00:00.000Z',
        read: false,
        messageId: 'opencode-terminal-stale-manifest',
      },
      {
        from: 'bob',
        to: 'jack',
        text: 'New row should wait behind the retried old row.',
        timestamp: '2026-02-23T17:00:02.000Z',
        read: false,
        messageId: 'opencode-terminal-new',
      },
    ]);
    const deliverSpy = vi
      .spyOn(service, 'deliverOpenCodeMemberMessage')
      .mockResolvedValue({ delivered: true, diagnostics: [] });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(markNextAttemptScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ledger-terminal-stale-manifest',
        status: 'retry_scheduled',
        reason: 'opencode_prompt_delivery_requeued_after_runtime_manifest_high_watermark_fix',
      })
    );
    expect(relay).toMatchObject({ relayed: 1, attempted: 1, delivered: 1, failed: 0 });
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({ messageId: 'opencode-terminal-stale-manifest' })
    );
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows.map((row: { read?: boolean }) => row.read)).toEqual([true, false]);
  });

  it('fails OpenCode secondary rows with missing attachment payloads terminally without text-only delivery', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    const identity = await (service as any).resolveOpenCodeMemberDeliveryIdentity(teamName, 'jack');
    expect(identity.ok).toBe(true);
    const records: any[] = [];
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getByInboxMessage: vi.fn(async () => null),
      ensurePending: vi.fn(async (input: Record<string, unknown>) => {
        const record = {
          id: 'ledger-attachment-1',
          status: 'pending',
          responseState: 'not_observed',
          diagnostics: [] as string[],
          ...input,
        };
        records.push(record);
        return record;
      }),
      markFailedTerminal: vi.fn(async (input: { id: string; reason: string; failedAt: string }) => {
        const record = records.find((candidate) => candidate.id === input.id);
        Object.assign(record, {
          status: 'failed_terminal',
          failedAt: input.failedAt,
          lastReason: input.reason,
          diagnostics: [input.reason],
        });
        return record;
      }),
      list: vi.fn(async () => records),
    });
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Please inspect the attachment.',
        timestamp: '2026-02-23T17:00:00.000Z',
        read: false,
        messageId: 'opencode-attachment-1',
        attachments: [
          {
            id: 'att-1',
            filename: 'trace.log',
            mimeType: 'text/plain',
            size: 128,
            addedAt: '2026-02-23T17:00:00.000Z',
          },
        ],
      },
    ]);
    const deliverSpy = vi.spyOn(service, 'deliverOpenCodeMemberMessage');
    const logSpy = vi
      .spyOn(service as any, 'logOpenCodePromptDeliveryEvent')
      .mockImplementation(() => undefined);

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');
    const expectedReason = 'opencode_inbox_attachment_payload_unavailable: att-1';

    expect(relay).toMatchObject({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 1,
      lastDelivery: {
        delivered: false,
        reason: expectedReason,
      },
    });
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(relay.diagnostics?.join('\n')).toContain(expectedReason);
    vi.mocked(console.warn).mockClear();
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows[0].read).toBe(false);
    expect(records[0]).toMatchObject({
      inboxMessageId: 'opencode-attachment-1',
      status: 'failed_terminal',
      lastReason: expectedReason,
    });
    expect(logSpy).toHaveBeenCalledWith(
      'opencode_prompt_delivery_terminal_failure',
      expect.objectContaining({
        inboxMessageId: 'opencode-attachment-1',
        status: 'failed_terminal',
        lastReason: expectedReason,
      }),
      expect.objectContaining({
        attachmentPayloadUnavailable: true,
        reason: expectedReason,
      })
    );
  });

  it('rebuilds missing OpenCode prompt ledger rows from unread inbox on startup scan', async () => {
    vi.useFakeTimers();
    try {
      const service = new TeamProvisioningService();
      const teamName = 'my-team';
      hoisted.files.set(
        `/mock/teams/${teamName}/config.json`,
        JSON.stringify({
          name: teamName,
          projectPath: '/tmp/my-team',
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
          ],
        })
      );
      const identity = await (service as any).resolveOpenCodeMemberDeliveryIdentity(
        teamName,
        'jack'
      );
      expect(identity.ok).toBe(true);
      const laneId = identity.laneId;
      const records: any[] = [];
      vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
        pruneTerminalRecords: vi.fn(async () => ({ pruned: 0, remaining: records.length })),
        list: vi.fn(async () => records),
        getByInboxMessage: vi.fn(async () => null),
        ensurePending: vi.fn(async (input: Record<string, unknown>) => {
          const record = {
            id: 'ledger-rebuild-1',
            status: 'pending',
            responseState: 'not_observed',
            acceptanceUnknown: false,
            diagnostics: [] as string[],
            ...input,
          };
          records.push(record);
          return record;
        }),
        markAcceptanceUnknown: vi.fn(
          async (input: {
            id: string;
            reason: string;
            nextAttemptAt: string;
            markedAt: string;
          }) => {
            const record = records.find((candidate) => candidate.id === input.id);
            Object.assign(record, {
              status: 'failed_retryable',
              acceptanceUnknown: true,
              nextAttemptAt: input.nextAttemptAt,
              lastReason: input.reason,
              updatedAt: input.markedAt,
            });
            return record;
          }
        ),
        markFailedTerminal: vi.fn(async (input: { id: string; reason: string }) => {
          const record = records.find((candidate) => candidate.id === input.id);
          Object.assign(record, {
            status: 'failed_terminal',
            lastReason: input.reason,
            diagnostics: [input.reason],
          });
          return record;
        }),
      });
      seedMemberInbox(teamName, 'jack', [
        {
          from: 'bob',
          to: 'jack',
          text: 'Recover this delivery.',
          timestamp: '2026-02-23T17:00:00.000Z',
          read: false,
          messageId: 'opencode-rebuild-1',
        },
      ]);

      const scheduled = await (service as any).scanOpenCodePromptDeliveryWatchdogForActiveLanes(
        teamName,
        [laneId]
      );

      expect(scheduled).toBe(1);
      expect(records[0]).toMatchObject({
        inboxMessageId: 'opencode-rebuild-1',
        status: 'failed_retryable',
        acceptanceUnknown: true,
        lastReason: 'opencode_prompt_delivery_ledger_rebuilt_from_unread_inbox',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules existing pending OpenCode prompt ledger rows with no next attempt on startup scan', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    const identity = await (service as any).resolveOpenCodeMemberDeliveryIdentity(teamName, 'jack');
    expect(identity.ok).toBe(true);
    const laneId = identity.laneId;
    const scheduleSpy = vi
      .spyOn(service as any, 'scheduleOpenCodePromptDeliveryWatchdog')
      .mockImplementation(() => undefined);
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      pruneTerminalRecords: vi.fn(async () => ({ pruned: 0, remaining: 1 })),
      list: vi.fn(async () => [
        {
          id: 'ledger-existing-pending-1',
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'opencode-existing-pending-1',
          status: 'pending',
          responseState: 'not_observed',
          attempts: 0,
          maxAttempts: 3,
          nextAttemptAt: null,
          diagnostics: [],
          createdAt: '2026-02-23T17:00:00.000Z',
        },
      ]),
      getByInboxMessage: vi.fn(async () => null),
    });

    const scheduled = await (service as any).scanOpenCodePromptDeliveryWatchdogForActiveLanes(
      teamName,
      [laneId]
    );

    expect(scheduled).toBe(1);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName,
        memberName: 'jack',
        messageId: 'opencode-existing-pending-1',
        delayMs: expect.any(Number),
      })
    );
  });

  it('queues a specific OpenCode relay behind an active member relay without duplicate prompts', async () => {
    vi.useFakeTimers();
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    try {
      hoisted.files.set(
        `/mock/teams/${teamName}/config.json`,
        JSON.stringify({
          name: teamName,
          projectPath: '/tmp/my-team',
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
          ],
        })
      );
      seedMemberInbox(teamName, 'jack', [
        {
          from: 'bob',
          to: 'jack',
          text: 'Older watcher message.',
          timestamp: '2026-02-23T17:00:00.000Z',
          read: false,
          messageId: 'opencode-inflight-old',
        },
      ]);

      const oldDeliveryStarted = createDeferred<void>();
      const releaseOldDelivery = createDeferred<void>();
      const deliverSpy = vi
        .spyOn(service, 'deliverOpenCodeMemberMessage')
        .mockImplementation(async (_teamName, input) => {
          if (input.messageId === 'opencode-inflight-old') {
            oldDeliveryStarted.resolve(undefined);
            await releaseOldDelivery.promise;
          }
          return { delivered: true, diagnostics: [] };
        });

      const watcherRelay = service.relayOpenCodeMemberInboxMessages(teamName, 'jack');
      await oldDeliveryStarted.promise;
      seedMemberInbox(teamName, 'jack', [
        {
          from: 'bob',
          to: 'jack',
          text: 'Older watcher message.',
          timestamp: '2026-02-23T17:00:00.000Z',
          read: false,
          messageId: 'opencode-inflight-old',
        },
        {
          from: 'user',
          to: 'jack',
          text: 'New UI message.',
          timestamp: '2026-02-23T17:00:01.000Z',
          read: false,
          messageId: 'opencode-inflight-new',
        },
      ]);

      await expect(
        service.relayOpenCodeMemberInboxMessages(teamName, 'jack', {
          onlyMessageId: 'opencode-inflight-new',
          source: 'ui-send',
          deliveryMetadata: { replyRecipient: 'user' },
        })
      ).resolves.toMatchObject({
        attempted: 1,
        delivered: 0,
        failed: 0,
        lastDelivery: {
          delivered: true,
          accepted: false,
          responsePending: true,
          queuedBehindMessageId: 'opencode-inflight-new',
          reason: 'opencode_inbox_relay_queued_behind_active_relay',
        },
      });
      releaseOldDelivery.resolve(undefined);

      await expect(watcherRelay).resolves.toMatchObject({
        attempted: 1,
        delivered: 1,
      });
      expect(deliverSpy).toHaveBeenCalledTimes(1);
      expect(deliverSpy).toHaveBeenCalledWith(
        teamName,
        expect.objectContaining({ messageId: 'opencode-inflight-old' })
      );
      const rows = JSON.parse(
        hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
      );
      expect(rows.map((row: { read?: boolean }) => row.read)).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an already-read work-sync nudge pending when it is queued behind an active relay', async () => {
    vi.useFakeTimers();
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    try {
      hoisted.files.set(
        `/mock/teams/${teamName}/config.json`,
        JSON.stringify({
          name: teamName,
          projectPath: '/tmp/my-team',
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
          ],
        })
      );
      seedMemberInbox(teamName, 'jack', [
        {
          from: 'bob',
          to: 'jack',
          text: 'Older watcher message.',
          timestamp: '2026-02-23T17:00:00.000Z',
          read: false,
          messageId: 'opencode-inflight-old',
        },
      ]);

      const oldDeliveryStarted = createDeferred<void>();
      const releaseOldDelivery = createDeferred<void>();
      vi.spyOn(service, 'deliverOpenCodeMemberMessage').mockImplementation(
        async (_teamName, input) => {
          if (input.messageId === 'opencode-inflight-old') {
            oldDeliveryStarted.resolve(undefined);
            await releaseOldDelivery.promise;
          }
          return { delivered: true, diagnostics: [] };
        }
      );
      const wakeSpy = vi
        .spyOn(service, 'scheduleOpenCodeMemberInboxDeliveryWake')
        .mockImplementation(() => undefined);

      const watcherRelay = service.relayOpenCodeMemberInboxMessages(teamName, 'jack');
      await oldDeliveryStarted.promise;
      seedMemberInbox(teamName, 'jack', [
        {
          from: 'bob',
          to: 'jack',
          text: 'Older watcher message.',
          timestamp: '2026-02-23T17:00:00.000Z',
          read: false,
          messageId: 'opencode-inflight-old',
        },
        {
          from: 'system',
          to: 'jack',
          text: 'Call member_work_sync_status, then member_work_sync_report.',
          timestamp: '2026-02-23T17:00:01.000Z',
          read: true,
          messageId: 'work-sync-read-queued',
          messageKind: 'member_work_sync_nudge',
          workSyncIntent: 'agenda_sync',
        },
      ]);

      await expect(
        service.relayOpenCodeMemberInboxMessages(teamName, 'jack', {
          onlyMessageId: 'work-sync-read-queued',
          source: 'watchdog',
        })
      ).resolves.toMatchObject({
        attempted: 1,
        delivered: 0,
        failed: 0,
        lastDelivery: {
          delivered: true,
          accepted: false,
          responsePending: true,
          reason: 'opencode_work_sync_read_commit_waiting_for_active_relay',
        },
      });
      expect(wakeSpy).toHaveBeenCalledWith({
        teamName,
        memberName: 'jack',
        messageId: 'work-sync-read-queued',
        delayMs: 500,
      });

      releaseOldDelivery.resolve(undefined);
      await watcherRelay;
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a hung existing OpenCode member relay in-flight lock', async () => {
    vi.useFakeTimers();
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const relayKey = `opencode:${teamName}:jack`;
    try {
      (
        service as unknown as {
          openCodeMemberInboxRelayInFlight: Map<string, Promise<unknown>>;
        }
      ).openCodeMemberInboxRelayInFlight.set(relayKey, new Promise(() => undefined));

      const relay = service.relayOpenCodeMemberInboxMessages(teamName, 'jack');
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(relay).resolves.toMatchObject({
        attempted: 0,
        delivered: 0,
        failed: 1,
        lastDelivery: {
          delivered: false,
          accepted: false,
          responsePending: false,
          reason: 'opencode_member_inbox_relay_timed_out',
        },
      });
      expect(
        (
          service as unknown as {
            openCodeMemberInboxRelayInFlight: Map<string, Promise<unknown>>;
          }
        ).openCodeMemberInboxRelayInFlight.has(relayKey)
      ).toBe(false);
      expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
        'opencode_member_inbox_relay_timed_out'
      );
      vi.mocked(console.warn).mockClear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a hung existing lead relay in-flight lock', async () => {
    vi.useFakeTimers();
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    try {
      (
        service as unknown as {
          leadInboxRelayInFlight: Map<string, Promise<number>>;
        }
      ).leadInboxRelayInFlight.set(teamName, new Promise(() => undefined));

      const relay = service.relayLeadInboxMessages(teamName);
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(relay).resolves.toBe(0);
      expect(
        (
          service as unknown as {
            leadInboxRelayInFlight: Map<string, Promise<number>>;
          }
        ).leadInboxRelayInFlight.has(teamName)
      ).toBe(false);
      expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
        'lead_inbox_relay_timed_out'
      );
      vi.mocked(console.warn).mockClear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a hung existing member relay in-flight lock', async () => {
    vi.useFakeTimers();
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const relayKey = `${teamName}:alice`;
    try {
      (
        service as unknown as {
          memberInboxRelayInFlight: Map<string, Promise<number>>;
        }
      ).memberInboxRelayInFlight.set(relayKey, new Promise(() => undefined));

      const relay = service.relayMemberInboxMessages(teamName, 'alice');
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(relay).resolves.toBe(0);
      expect(
        (
          service as unknown as {
            memberInboxRelayInFlight: Map<string, Promise<number>>;
          }
        ).memberInboxRelayInFlight.has(relayKey)
      ).toBe(false);
      expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
        'member_inbox_relay_timed_out'
      );
      vi.mocked(console.warn).mockClear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not convert non-timeout member relay failures into timeout results', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const relayKey = `${teamName}:alice`;
    const rejected = Promise.reject(new Error('relay failed'));
    rejected.catch(() => undefined);
    (
      service as unknown as {
        memberInboxRelayInFlight: Map<string, Promise<number>>;
      }
    ).memberInboxRelayInFlight.set(relayKey, rejected);

    await expect(service.relayMemberInboxMessages(teamName, 'alice')).rejects.toThrow(
      'relay failed'
    );
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it('treats an already-read specific OpenCode inbox row as delivered for UI-send relay', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'user',
        to: 'jack',
        text: 'Already relayed.',
        timestamp: '2026-02-23T17:02:00.000Z',
        read: true,
        messageId: 'opencode-already-read-1',
      },
    ]);
    const deliverSpy = vi.spyOn(service, 'deliverOpenCodeMemberMessage');

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack', {
      onlyMessageId: 'opencode-already-read-1',
      source: 'ui-send',
    });

    expect(relay).toMatchObject({
      relayed: 0,
      attempted: 1,
      delivered: 1,
      failed: 0,
      lastDelivery: { delivered: true },
    });
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it('does not treat an already-read work-sync nudge as delivered without the work-sync proof path', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'system',
        to: 'jack',
        text: 'Call member_work_sync_status, then member_work_sync_report.',
        timestamp: '2026-02-23T17:02:00.000Z',
        read: true,
        messageId: 'work-sync-read-1',
        messageKind: 'member_work_sync_nudge',
        workSyncIntent: 'agenda_sync',
        taskRefs: [{ taskId: 'task-1', teamName }],
      },
    ]);
    const deliverSpy = vi.spyOn(service, 'deliverOpenCodeMemberMessage').mockResolvedValue({
      delivered: true,
      accepted: false,
      responsePending: true,
      reason: 'member_work_sync_report_required',
      diagnostics: ['member_work_sync_report_required'],
    });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack', {
      onlyMessageId: 'work-sync-read-1',
      source: 'watchdog',
    });

    expect(deliverSpy).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({
        memberName: 'jack',
        messageId: 'work-sync-read-1',
        messageKind: 'member_work_sync_nudge',
        workSyncIntent: 'agenda_sync',
      })
    );
    expect(relay).toMatchObject({
      attempted: 1,
      delivered: 0,
      failed: 0,
      lastDelivery: {
        delivered: true,
        accepted: false,
        responsePending: true,
        reason: 'member_work_sync_report_required',
      },
    });
  });

  it('routes watcher inbox changes for OpenCode members through direct runtime relay', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Please review this.',
        timestamp: '2026-02-23T17:05:00.000Z',
        read: false,
        messageId: 'opencode-selector-relay-1',
      },
    ]);
    vi.spyOn(service, 'deliverOpenCodeMemberMessage').mockResolvedValue({
      delivered: true,
      diagnostics: [],
    });
    const recipientSpy = vi.spyOn(service, 'isOpenCodeRuntimeRecipient');

    const relay = await service.relayInboxFileToLiveRecipient(teamName, 'jack');

    expect(relay).toMatchObject({ kind: 'opencode_member', relayed: 1 });
    expect(recipientSpy).toHaveBeenCalledTimes(1);
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows[0].read).toBe(true);
  });

  it('routes OpenCode lead inbox rows through OpenCode member relay', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: 'opencode',
            model: 'openrouter/test',
          },
        ],
      })
    );
    seedLeadInbox(teamName, [
      {
        from: 'user',
        to: 'team-lead',
        text: 'Please coordinate.',
        timestamp: '2026-02-23T17:06:00.000Z',
        read: false,
        messageId: 'opencode-lead-unread-1',
      },
    ]);
    const relaySpy = vi
      .spyOn((service as any).leadInboxRelayFacade, 'relayOpenCodeMemberInboxMessages')
      .mockResolvedValue({
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
      diagnostics: ['fake OpenCode lead relay ready'],
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: false,
      },
    });

    const relay = await service.relayInboxFileToLiveRecipient(teamName, 'team-lead', {
      onlyMessageId: 'opencode-lead-unread-1',
      source: 'ui-send',
      deliveryMetadata: {
        replyRecipient: 'user',
        actionMode: 'do',
      },
    });

    expect(relay).toMatchObject({
      kind: 'opencode_member',
      relayed: 1,
      diagnostics: ['fake OpenCode lead relay ready'],
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: false,
      },
    });
    expect(relaySpy).toHaveBeenCalledWith(
      teamName,
      'team-lead',
      expect.objectContaining({
        onlyMessageId: 'opencode-lead-unread-1',
        source: 'ui-send',
        deliveryMetadata: expect.objectContaining({
          replyRecipient: 'user',
          actionMode: 'do',
        }),
      })
    );
  });

  it('keeps failed OpenCode member inbox relay rows unread for retry', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Please review this.',
        timestamp: '2026-02-23T17:10:00.000Z',
        read: false,
        messageId: 'opencode-relay-failed-1',
      },
    ]);
    vi.spyOn(service, 'deliverOpenCodeMemberMessage').mockResolvedValue({
      delivered: false,
      reason: 'opencode_runtime_not_active',
      diagnostics: ['opencode_runtime_not_active'],
    });

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(relay).toMatchObject({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 1,
      lastDelivery: { delivered: false, reason: 'opencode_runtime_not_active' },
    });
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'OpenCode inbox relay failed for jack/opencode-relay-failed-1'
    );
    vi.mocked(console.warn).mockClear();
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows[0].read).toBe(false);
  });

  it('treats OpenCode mark-read failure after prompt acceptance as an uncommitted relay', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    hoisted.files.set(
      `/mock/teams/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    seedMemberInbox(teamName, 'jack', [
      {
        from: 'bob',
        to: 'jack',
        text: 'Please review this.',
        timestamp: '2026-02-23T17:20:00.000Z',
        read: false,
        messageId: 'opencode-mark-read-failed-1',
      },
    ]);
    vi.spyOn(service, 'deliverOpenCodeMemberMessage').mockResolvedValue({
      delivered: true,
      diagnostics: [],
    });
    vi.spyOn(service as any, 'markInboxMessagesRead').mockRejectedValue(new Error('write failed'));

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(relay).toMatchObject({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 1,
      lastDelivery: {
        delivered: false,
        reason: 'opencode_inbox_mark_read_failed_after_delivery',
      },
    });
    expect(relay.diagnostics?.join('\n')).toContain(
      'opencode_inbox_mark_read_failed_after_delivery'
    );
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'opencode_inbox_mark_read_failed_after_delivery'
    );
    vi.mocked(console.warn).mockClear();
    const rows = JSON.parse(hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]');
    expect(rows[0].read).toBe(false);
  });

  it('fails closed when OpenCode prompt ledger cannot be inspected for work-sync busy checks', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      OpenCodeRuntimeStore.getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-02-23T17:30:00.000Z',
        lanes: {
          primary: {
            laneId: 'primary',
            state: 'active',
            updatedAt: '2026-02-23T17:30:00.000Z',
          },
          [laneId]: {
            laneId,
            state: 'active',
            updatedAt: '2026-02-23T17:30:00.000Z',
          },
        },
      })
    );
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          updatedAt: '2026-02-23T17:30:00.000Z',
        },
      },
    });
    hoisted.files.set(`${teamsBasePath}/${teamName}/inboxes/jack.json`, JSON.stringify([]));
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getActiveForMember: vi.fn(async () => {
        throw new Error('ledger read failed');
      }),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:00.000Z',
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_prompt_ledger_unavailable',
    });
  });

  it('treats unread OpenCode foreground inbox messages as busy for work-sync checks', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const teamsBasePath = getTeamsBasePath();
    const wakeSpy = vi
      .spyOn(service, 'scheduleOpenCodeMemberInboxDeliveryWake')
      .mockImplementation(() => undefined);
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'user',
          to: 'jack',
          text: 'Please check the current issue.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'foreground-message-1',
          messageKind: 'direct',
        },
      ])
    );

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:10.000Z',
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'foreground-message-1',
    });
    expect(wakeSpy).toHaveBeenCalledWith({
      teamName,
      memberName: 'jack',
      messageId: 'foreground-message-1',
      delayMs: 500,
    });
  });

  it('wakes an active OpenCode foreground delivery instead of blocking work-sync on unread inbox state', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const wakeSpy = vi
      .spyOn(service, 'scheduleOpenCodeMemberInboxDeliveryWake')
      .mockImplementation(() => undefined);
    seedOpenCodeBusyStatusFixture({
      service,
      teamName,
      laneId,
      inboxMessages: [
        {
          from: 'team-lead',
          to: 'jack',
          text: 'New task assigned to you.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'foreground-message-1',
          messageKind: 'default',
        },
      ],
      activeRecord: {
        inboxMessageId: 'foreground-message-1',
        messageKind: 'default',
        nextAttemptAt: '2026-02-23T17:33:00.000Z',
      },
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'agenda_sync',
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_prompt_delivery_active:default',
      activeMessageId: 'foreground-message-1',
      retryAfterIso: '2026-02-23T17:33:00.000Z',
    });
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName,
        memberName: 'jack',
        messageId: 'foreground-message-1',
      })
    );
  });

  it('prioritizes an active OpenCode prompt ledger over newer unread foreground messages', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const wakeSpy = vi
      .spyOn(service, 'scheduleOpenCodeMemberInboxDeliveryWake')
      .mockImplementation(() => undefined);
    seedOpenCodeBusyStatusFixture({
      service,
      teamName,
      laneId,
      inboxMessages: [
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Follow-up comment after assignment.',
          timestamp: '2026-02-23T17:32:00.000Z',
          read: false,
          messageId: 'foreground-comment-1',
          messageKind: 'default',
        },
      ],
      activeRecord: {
        inboxMessageId: 'foreground-assignment-1',
        messageKind: 'default',
        nextAttemptAt: '2026-02-23T17:33:00.000Z',
      },
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:10.000Z',
      workSyncIntent: 'agenda_sync',
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_prompt_delivery_active:default',
      activeMessageId: 'foreground-assignment-1',
      retryAfterIso: '2026-02-23T17:33:00.000Z',
    });
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName,
        memberName: 'jack',
        messageId: 'foreground-assignment-1',
      })
    );
  });

  it('recovers a missing OpenCode lane before using an active prompt ledger as busy state', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const memberName = 'jack';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: memberName, role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/${memberName}.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: memberName,
          text: 'New task assigned to you.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'foreground-message-1',
          messageKind: 'default',
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: memberName,
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex')
      .mockResolvedValueOnce({
        version: 1,
        updatedAt: '2026-02-23T17:30:00.000Z',
        lanes: {},
      })
      .mockResolvedValue({
        version: 1,
        updatedAt: '2026-02-23T17:30:01.000Z',
        lanes: {
          [laneId]: {
            laneId,
            state: 'active',
            updatedAt: '2026-02-23T17:30:01.000Z',
          },
        },
      });
    const recoverySpy = vi
      .spyOn(service as any, 'tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery')
      .mockResolvedValue(true);
    const wakeSpy = vi
      .spyOn(service, 'scheduleOpenCodeMemberInboxDeliveryWake')
      .mockImplementation(() => undefined);
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getActiveForMember: vi.fn(async () => ({
        id: 'ledger-foreground-message-1',
        teamName,
        memberName,
        laneId,
        inboxMessageId: 'foreground-message-1',
        messageKind: 'default',
        status: 'pending',
        responseState: 'not_observed',
        nextAttemptAt: '2026-02-23T17:33:00.000Z',
      })),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName,
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'agenda_sync',
    });

    expect(recoverySpy).toHaveBeenCalledWith({ teamName, memberName });
    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_prompt_delivery_active:default',
      activeMessageId: 'foreground-message-1',
    });
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ teamName, memberName, messageId: 'foreground-message-1' })
    );
  });

  it('does not use an active OpenCode prompt ledger when recovery leaves the lane inactive', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const memberName = 'jack';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: memberName, role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/${memberName}.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: memberName,
          text: 'New task assigned to you.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'foreground-message-1',
          messageKind: 'default',
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: memberName,
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {},
    });
    const recoverySpy = vi
      .spyOn(service as any, 'tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery')
      .mockResolvedValue(true);
    const wakeSpy = vi
      .spyOn(service, 'scheduleOpenCodeMemberInboxDeliveryWake')
      .mockImplementation(() => undefined);
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getActiveForMember: vi.fn(async () => ({
        id: 'ledger-foreground-message-1',
        teamName,
        memberName,
        laneId,
        inboxMessageId: 'foreground-message-1',
        messageKind: 'default',
        status: 'pending',
        responseState: 'not_observed',
        nextAttemptAt: '2026-02-23T17:33:00.000Z',
      })),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName,
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'agenda_sync',
    });

    expect(recoverySpy).toHaveBeenCalledWith({ teamName, memberName });
    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'foreground-message-1',
    });
    expect(wakeSpy).toHaveBeenCalledWith({
      teamName,
      memberName,
      messageId: 'foreground-message-1',
      delayMs: 500,
    });
  });

  it('recovers a missing OpenCode lane before treating work-sync delivery as unavailable', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const memberName = 'jack';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: memberName, role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/${memberName}.json`,
      JSON.stringify([])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: memberName,
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex')
      .mockResolvedValueOnce({
        version: 1,
        updatedAt: '2026-02-23T17:30:00.000Z',
        lanes: {},
      })
      .mockResolvedValue({
        version: 1,
        updatedAt: '2026-02-23T17:30:01.000Z',
        lanes: {
          [laneId]: {
            laneId,
            state: 'active',
            updatedAt: '2026-02-23T17:30:01.000Z',
          },
        },
      });
    const recoverySpy = vi
      .spyOn(service as any, 'tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery')
      .mockResolvedValue(true);
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getActiveForMember: vi.fn(async () => null),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName,
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'agenda_sync',
    });

    expect(recoverySpy).toHaveBeenCalledWith({ teamName, memberName });
    expect(busy).toEqual({ busy: false });
  });

  it('keeps OpenCode work-sync busy when recovery reports success but lane index is still inactive', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const memberName = 'jack';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: memberName, role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/${memberName}.json`,
      JSON.stringify([])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: memberName,
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {},
    });
    const recoverySpy = vi
      .spyOn(service as any, 'tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery')
      .mockResolvedValue(true);

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName,
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'agenda_sync',
    });

    expect(recoverySpy).toHaveBeenCalledWith({ teamName, memberName });
    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_no_active_lane',
    });
  });

  it('does not let proof-missing recovery get blocked by its original unread message', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'user',
          to: 'jack',
          text: 'Please check the current issue.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'foreground-message-1',
          messageKind: 'direct',
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          updatedAt: '2026-02-23T17:30:00.000Z',
        },
      },
    });
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getActiveForMember: vi.fn(async () => null),
    });

    const sameMessageRecoveryBusy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'agenda_sync',
      workSyncIntentKey: 'proof-missing:foreground-message-1',
    });

    expect(sameMessageRecoveryBusy).toEqual({ busy: false });

    const unrelatedRecoveryBusy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'agenda_sync',
      workSyncIntentKey: 'proof-missing:another-message',
    });

    expect(unrelatedRecoveryBusy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'foreground-message-1',
    });
  });

  it('allows OpenCode agenda-sync recovery past the exact proof-missing foreground message', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          updatedAt: '2026-02-23T17:30:00.000Z',
        },
      },
    });
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      list: vi.fn(async () => [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'proof-missing-message-1',
          taskRefs: [taskRef],
        }),
      ]),
      getActiveForMember: vi.fn(async () => null),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toEqual({ busy: false });
  });

  it('allows OpenCode agenda-sync proof-missing bypass after recovering a missing lane index', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex')
      .mockResolvedValueOnce({
        version: 1,
        updatedAt: '2026-02-23T17:30:00.000Z',
        lanes: {},
      })
      .mockResolvedValue({
        version: 1,
        updatedAt: '2026-02-23T17:30:01.000Z',
        lanes: {
          [laneId]: {
            laneId,
            state: 'active',
            updatedAt: '2026-02-23T17:30:01.000Z',
          },
        },
      });
    const recoverySpy = vi
      .spyOn(service as any, 'tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery')
      .mockResolvedValue(true);
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      list: vi.fn(async () => [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'proof-missing-message-1',
          taskRefs: [taskRef],
        }),
      ]),
      getActiveForMember: vi.fn(async () => null),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(recoverySpy).toHaveBeenCalledWith({ teamName, memberName: 'jack' });
    expect(busy).toEqual({ busy: false });
  });

  it('keeps OpenCode agenda-sync proof-missing bypass disabled when lane index is unreadable', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockRejectedValue(
      new Error('temporary read failure')
    );
    const recoverySpy = vi
      .spyOn(service as any, 'tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery')
      .mockResolvedValue(true);

    const bypass = await (service as any).getOpenCodeAgendaSyncRecoveryBypassMessageIds({
      teamName,
      memberName: 'jack',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
      foregroundMessages: [
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ],
    });

    expect(recoverySpy).not.toHaveBeenCalled();
    expect(bypass).toEqual(new Set());
  });

  it('allows OpenCode agenda-sync recovery for legacy proof-missing foreground ids', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    const legacyMessage = {
      from: 'team-lead',
      to: 'jack',
      text: 'Please continue task #task1234.',
      timestamp: '2026-02-23T17:31:00.000Z',
      read: false,
      messageKind: 'default',
      taskRefs: [taskRef],
    };
    const legacyMessageId = buildLegacyInboxMessageId(
      legacyMessage.from,
      legacyMessage.timestamp,
      legacyMessage.text
    );
    seedOpenCodeBusyStatusFixture({
      service,
      teamName,
      laneId,
      inboxMessages: [legacyMessage],
      ledgerRecords: [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: legacyMessageId,
          taskRefs: [taskRef],
        }),
      ],
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toEqual({ busy: false });
  });

  it('keeps newer same-task OpenCode foreground messages busy during agenda-sync recovery', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    seedOpenCodeBusyStatusFixture({
      service,
      teamName,
      laneId,
      inboxMessages: [
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Dependency resolved. Please re-check #task1234.',
          timestamp: '2026-02-23T17:31:40.000Z',
          read: false,
          messageId: 'same-task-follow-up-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ],
      ledgerRecords: [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'proof-missing-message-1',
          taskRefs: [taskRef],
        }),
      ],
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'same-task-follow-up-1',
    });
  });

  it('keeps OpenCode agenda-sync busy when proof-missing recovery evidence is absent', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'foreground-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          updatedAt: '2026-02-23T17:30:00.000Z',
        },
      },
    });
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      list: vi.fn(async () => []),
      getActiveForMember: vi.fn(async () => null),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'foreground-message-1',
    });
  });

  it('keeps unrelated unread OpenCode foreground messages busy during agenda-sync recovery', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
        {
          from: 'user',
          to: 'jack',
          text: 'Unrelated direct instruction.',
          timestamp: '2026-02-23T17:31:20.000Z',
          read: false,
          messageId: 'unrelated-message-1',
          messageKind: 'direct',
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          updatedAt: '2026-02-23T17:30:00.000Z',
        },
      },
    });
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      list: vi.fn(async () => [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'proof-missing-message-1',
          taskRefs: [taskRef],
        }),
      ]),
      getActiveForMember: vi.fn(async () => null),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:30.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'unrelated-message-1',
    });
  });

  it('keeps OpenCode agenda-sync busy when an active prompt ledger record exists after recovery bypass', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    const proofMissingRecord = buildOpenCodeProofMissingRecord({
      teamName,
      memberName: 'jack',
      laneId,
      inboxMessageId: 'proof-missing-message-1',
      taskRefs: [taskRef],
    });
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          updatedAt: '2026-02-23T17:30:00.000Z',
        },
      },
    });
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      list: vi.fn(async () => [proofMissingRecord]),
      getActiveForMember: vi.fn(async () => ({
        ...proofMissingRecord,
        id: 'opencode-prompt:active-nudge-1',
        inboxMessageId: 'active-nudge-1',
        messageKind: 'member_work_sync_nudge',
        status: 'accepted',
        nextAttemptAt: '2026-02-23T17:33:00.000Z',
      })),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_prompt_delivery_active:member_work_sync_nudge',
      activeMessageId: 'active-nudge-1',
      retryAfterIso: '2026-02-23T17:33:00.000Z',
    });
  });

  it('keeps OpenCode agenda-sync busy for same-task proof-missing messages with attachments', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
          attachments: [{ id: 'attachment-1', filename: 'notes.txt', mimeType: 'text/plain' }],
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          updatedAt: '2026-02-23T17:30:00.000Z',
        },
      },
    });
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      list: vi.fn(async () => [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'proof-missing-message-1',
          taskRefs: [taskRef],
        }),
      ]),
      getActiveForMember: vi.fn(async () => null),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'proof-missing-message-1',
    });
  });

  it('keeps OpenCode proof-missing foreground messages busy outside agenda-sync recovery', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    seedOpenCodeBusyStatusFixture({
      service,
      teamName,
      laneId,
      inboxMessages: [
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ],
      ledgerRecords: [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'proof-missing-message-1',
          taskRefs: [taskRef],
        }),
      ],
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'proof-missing-message-1',
    });
  });

  it('keeps OpenCode agenda-sync busy when proof-missing record task refs do not overlap', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    const otherTaskRef = { teamName, taskId: 'task-9999', displayId: 'task9999' };
    seedOpenCodeBusyStatusFixture({
      service,
      teamName,
      laneId,
      inboxMessages: [
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ],
      ledgerRecords: [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'proof-missing-message-1',
          taskRefs: [otherTaskRef],
        }),
      ],
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'proof-missing-message-1',
    });
  });

  it('keeps OpenCode agenda-sync busy when terminal ledger reason is not proof missing', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    seedOpenCodeBusyStatusFixture({
      service,
      teamName,
      laneId,
      inboxMessages: [
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'terminal-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ],
      ledgerRecords: [
        {
          ...buildOpenCodeProofMissingRecord({
            teamName,
            memberName: 'jack',
            laneId,
            inboxMessageId: 'terminal-message-1',
            taskRefs: [taskRef],
          }),
          responseState: 'permission_blocked',
          lastReason: 'permission_blocked',
          diagnostics: ['permission_blocked'],
        },
      ],
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'terminal-message-1',
    });
  });

  it('keeps OpenCode agenda-sync busy when the proof-missing lane is inactive', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const taskRef = { teamName, taskId: 'task-1234', displayId: 'task1234' };
    seedOpenCodeBusyStatusFixture({
      service,
      teamName,
      laneId,
      laneState: 'stopped',
      inboxMessages: [
        {
          from: 'team-lead',
          to: 'jack',
          text: 'Please continue task #task1234.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'proof-missing-message-1',
          messageKind: 'default',
          taskRefs: [taskRef],
        },
      ],
      ledgerRecords: [
        buildOpenCodeProofMissingRecord({
          teamName,
          memberName: 'jack',
          laneId,
          inboxMessageId: 'proof-missing-message-1',
          taskRefs: [taskRef],
        }),
      ],
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:32:00.000Z',
      workSyncIntent: 'agenda_sync',
      taskRefs: [taskRef],
    });

    expect(busy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'proof-missing-message-1',
    });
  });

  it('does not treat the current unread OpenCode review request as busy for review-pickup checks', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'jack',
          text: '**Please review** task #task1234\n\nFIRST call review_start.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'review-request-1',
          source: 'system_notification',
          summary: 'Review request for #task1234',
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(() =>
      Promise.resolve({
        ok: true,
        canonicalMemberName: 'jack',
        laneId,
      })
    );
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockReturnValue(
      Promise.resolve({
        version: 1,
        updatedAt: '2026-02-23T17:30:00.000Z',
        lanes: {
          [laneId]: {
            laneId,
            state: 'active',
            updatedAt: '2026-02-23T17:30:00.000Z',
          },
        },
      })
    );
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getActiveForMember: vi.fn(() => Promise.resolve(null)),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'review_pickup',
      taskRefs: [{ teamName, taskId: 'task-1234', displayId: 'task1234' }],
    });

    expect(busy).toEqual({ busy: false });

    const mismatchedTaskBusy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:10.000Z',
      workSyncIntent: 'review_pickup',
      taskRefs: [{ teamName, taskId: 'other-task', displayId: 'other' }],
    });

    expect(mismatchedTaskBusy).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'review-request-1',
    });
  });

  it('does not treat unread OpenCode work-sync nudges as foreground busy blockers', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    const laneId = 'secondary:opencode:jack';
    const teamsBasePath = getTeamsBasePath();
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/config.json`,
      JSON.stringify({
        name: teamName,
        projectPath: '/tmp/my-team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', role: 'developer', providerId: 'opencode', model: 'openrouter/test' },
        ],
      })
    );
    hoisted.files.set(
      `${teamsBasePath}/${teamName}/inboxes/jack.json`,
      JSON.stringify([
        {
          from: 'system',
          to: 'jack',
          text: 'Work sync check.',
          timestamp: '2026-02-23T17:31:00.000Z',
          read: false,
          messageId: 'work-sync-nudge-1',
          messageKind: 'member_work_sync_nudge',
        },
      ])
    );
    (service as any).resolveOpenCodeMemberDeliveryIdentity = vi.fn(async () => ({
      ok: true,
      canonicalMemberName: 'jack',
      laneId,
    }));
    vi.spyOn(OpenCodeRuntimeStore, 'readOpenCodeRuntimeLaneIndex').mockResolvedValue({
      version: 1,
      updatedAt: '2026-02-23T17:30:00.000Z',
      lanes: {
        [laneId]: {
          laneId,
          state: 'active',
          updatedAt: '2026-02-23T17:30:00.000Z',
        },
      },
    });
    vi.spyOn(service as any, 'createOpenCodePromptDeliveryLedger').mockReturnValue({
      getActiveForMember: vi.fn(async () => null),
    });

    const busy = await service.getOpenCodeMemberDeliveryBusyStatus({
      teamName,
      memberName: 'jack',
      nowIso: '2026-02-23T17:31:10.000Z',
    });

    expect(busy).toEqual({ busy: false });
  });
});
