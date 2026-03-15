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

  return {
    files,
    stat,
    readFile,
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
    },
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
  createController: ({ teamName }: { teamName: string }) => ({
    messages: {
      appendSentMessage: (message: Record<string, unknown>) =>
        hoisted.appendSentMessage(teamName, message),
      sendMessage: (message: Record<string, unknown>) =>
        hoisted.sendInboxMessage(teamName, message),
    },
  }),
}));

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

function attachAliveRun(
  service: TeamProvisioningService,
  teamName: string,
  opts?: { writable?: boolean }
): { writeSpy: ReturnType<typeof vi.fn> } {
  const runId = 'run-1';
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
    leadMsgSeq: 0,
    pendingToolCalls: [],
    pendingDirectCrossTeamSendRefresh: false,
    lastLeadTextEmitMs: 0,
    activeCrossTeamReplyHints: [],
    pendingInboxRelayCandidates: [],
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
    provisioningComplete: true,
    leadRelayCapture: null,
  });

  return { writeSpy };
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
    hoisted.atomicWrite.mockClear();
    hoisted.appendSentMessage.mockClear();
    hoisted.sendInboxMessage.mockClear();
    hoisted.setAtomicWriteShouldFail(false);
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

  it('adds task-first reply guidance for task comment notifications in lead relay prompts', async () => {
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
    expect(payload).toContain('Prefer replying on the task via task_add_comment');

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

  it('ignores unread lead inbox rows without messageId', async () => {
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
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);
    expect(hoisted.appendSentMessage).not.toHaveBeenCalled();
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
    expect(payload).toContain('recipient=\\"alice\\"');
    expect(payload).toContain('Source: system_notification');
    expect(payload).toContain('Forward that automated notification exactly once;');
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
});
