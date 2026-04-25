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
    return {
      isFile: () => true,
      size: Buffer.byteLength(data, 'utf8'),
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
    sendInboxMessage: vi.fn(
      (teamName: string, message: Record<string, unknown>) => {
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
      }
    ),
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
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

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
    expect(payload).toContain('reply via task_add_comment only when you have a substantive board update');
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
    expect(hoisted.appendSentMessage).toHaveBeenCalledTimes(1);
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
    const inboxReader = (service as unknown as {
      inboxReader: { getMessagesFor: (team: string, member: string) => Promise<typeof inboxMessages> };
    }).inboxReader;
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
    const inboxReader = (service as unknown as {
      inboxReader: {
        getMessagesFor: (
          team: string,
          member: string
        ) => Promise<[typeof permissionMessage]>;
      };
    }).inboxReader;
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
    expect(payload).toContain('Call the MCP tool named cross_team_send with toTeam=\\"other-team\\"');
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
      silentUserDmForward: { target: string; startedAt: string; mode: 'user_dm' | 'member_inbox_relay' } | null;
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
    const inboxReader = (service as unknown as {
      inboxReader: { getMessagesFor: (team: string, member: string) => Promise<typeof inboxMessages> };
    }).inboxReader;
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
        messageId: buildLegacyInboxMessageId(
          legacyRow.from,
          legacyRow.timestamp,
          legacyRow.text
        ),
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
      .spyOn(service as any, 'confirmSameTeamNativeMatches')
      .mockResolvedValue({ nativeMatchedMessageIds: new Set<string>(), persisted: true });

    const { writeSpy } = attachAliveRun(service, teamName);
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);
    expect(nativeMatchSpy).toHaveBeenCalledWith(teamName, 'team-lead', []);
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
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
    );
    expect(rows[0].read).toBe(true);
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
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
    );
    expect(rows[0].read).toBe(false);
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
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
    );
    expect(rows.map((row: { read?: boolean }) => row.read)).toEqual([false, true]);
  });

  it('fails OpenCode secondary rows with attachments terminally without text-only delivery', async () => {
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

    const relay = await service.relayOpenCodeMemberInboxMessages(teamName, 'jack');

    expect(relay).toMatchObject({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 1,
      lastDelivery: {
        delivered: false,
        reason: 'opencode_attachments_not_supported_for_secondary_runtime',
      },
    });
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'opencode_attachments_not_supported_for_secondary_runtime'
    );
    vi.mocked(console.warn).mockClear();
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
    );
    expect(rows[0].read).toBe(false);
    expect(records[0]).toMatchObject({
      inboxMessageId: 'opencode-attachment-1',
      status: 'failed_terminal',
      lastReason: 'opencode_attachments_not_supported_for_secondary_runtime',
    });
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
      const identity = await (service as any).resolveOpenCodeMemberDeliveryIdentity(teamName, 'jack');
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
          async (input: { id: string; reason: string; nextAttemptAt: string; markedAt: string }) => {
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

  it('does not let an older in-flight OpenCode relay mask a specific UI-send message', async () => {
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

    const uiRelay = service.relayOpenCodeMemberInboxMessages(teamName, 'jack', {
      onlyMessageId: 'opencode-inflight-new',
      source: 'ui-send',
      deliveryMetadata: { replyRecipient: 'user' },
    });
    releaseOldDelivery.resolve(undefined);

    await expect(watcherRelay).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
    });
    await expect(uiRelay).resolves.toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(deliverSpy).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({ messageId: 'opencode-inflight-old' })
    );
    expect(deliverSpy).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({ messageId: 'opencode-inflight-new' })
    );
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
    );
    expect(rows.map((row: { read?: boolean }) => row.read)).toEqual([true, true]);
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

    const relay = await service.relayInboxFileToLiveRecipient(teamName, 'jack');

    expect(relay).toMatchObject({ kind: 'opencode_member', relayed: 1 });
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
    );
    expect(rows[0].read).toBe(true);
  });

  it('leaves OpenCode lead inbox rows unread with an explicit unsupported diagnostic', async () => {
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

    const relay = await service.relayInboxFileToLiveRecipient(teamName, 'team-lead');

    expect(relay).toMatchObject({ kind: 'opencode_lead_unsupported', relayed: 0 });
    expect(relay.diagnostics?.join('\n')).toContain('opencode_lead_runtime_session_missing');
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'opencode_lead_runtime_session_missing'
    );
    vi.mocked(console.warn).mockClear();
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/team-lead.json`) ?? '[]'
    );
    expect(rows[0].read).toBe(false);
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
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
    );
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
    vi.spyOn(service as any, 'markInboxMessagesRead').mockRejectedValue(
      new Error('write failed')
    );

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
    const rows = JSON.parse(
      hoisted.files.get(`/mock/teams/${teamName}/inboxes/jack.json`) ?? '[]'
    );
    expect(rows[0].read).toBe(false);
  });
});
