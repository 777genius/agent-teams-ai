import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();

  const norm = (p: string): string => p.replace(/\\/g, '/');

  const stat = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return { isFile: () => true, size: Buffer.byteLength(data, 'utf8') };
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
    files.set(norm(filePath), data);
  });

  return {
    files,
    stat,
    readFile,
    atomicWrite,
    appendSentMessage: vi.fn((teamName: string, message: Record<string, unknown>) => {
      const p = `/mock/teams/${teamName}/sentMessages.json`;
      const current = files.get(p);
      const rows = current ? (JSON.parse(current) as unknown[]) : [];
      rows.push(message);
      files.set(p, JSON.stringify(rows));
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
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, stat: hoisted.stat, readFile: hoisted.readFile },
  };
});

vi.mock('../../../../src/main/services/team/atomicWrite', () => ({
  atomicWriteAsync: hoisted.atomicWrite,
}));

vi.mock('../../../../src/main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/pathDecoder')>();
  return { ...actual, getTeamsBasePath: () => '/mock/teams' };
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

import type { TeamChangeEvent } from '@shared/types/team';
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

interface RunLike {
  runId: string;
  teamName: string;
  provisioningComplete: boolean;
  leadMsgSeq: number;
  pendingToolCalls: { name: string; preview: string }[];
  lastLeadTextEmitMs: number;
  leadRelayCapture: null;
  silentUserDmForward: null;
  suppressPostCompactReminderOutput?: boolean;
  child: Record<string, unknown> | null;
  processKilled: boolean;
  cancelRequested: boolean;
  provisioningOutputParts: string[];
  request: { members: { name: string; role?: string }[] };
  activeCrossTeamReplyHints?: Array<{ toTeam: string; conversationId: string }>;
}

/**
 * Attach a run to the service internals. `provisioningComplete` defaults to false
 * (pre-ready) to test the early message pipeline.
 */
function attachRun(
  service: TeamProvisioningService,
  teamName: string,
  opts?: { provisioningComplete?: boolean }
): RunLike {
  const runId = 'run-1';
  const run: RunLike = {
    runId,
    teamName,
    provisioningComplete: opts?.provisioningComplete ?? false,
    leadMsgSeq: 0,
    pendingToolCalls: [],
    lastLeadTextEmitMs: 0,
    leadRelayCapture: null,
    silentUserDmForward: null,
    child: { stdin: { writable: true, write: vi.fn(), end: vi.fn() } },
    processKilled: false,
    cancelRequested: false,
    provisioningOutputParts: [],
    request: { members: [{ name: 'team-lead', role: 'Team Lead' }] },
    activeCrossTeamReplyHints: [],
  };

  (service as unknown as { activeByTeam: Map<string, string> }).activeByTeam.set(teamName, runId);
  (service as unknown as { runs: Map<string, unknown> }).runs.set(runId, run);

  return run;
}

function callHandleStreamJsonMessage(
  service: TeamProvisioningService,
  run: RunLike,
  msg: Record<string, unknown>
): void {
  (service as unknown as { handleStreamJsonMessage: (r: unknown, m: unknown) => void })
    .handleStreamJsonMessage(run, msg);
}

describe('TeamProvisioningService pre-ready live messages', () => {
  beforeEach(() => {
    hoisted.files.clear();
    hoisted.appendSentMessage.mockClear();
    hoisted.sendInboxMessage.mockClear();
  });

  it('pre-ready assistant text is added to liveLeadProcessMessages', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: false });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Команда создана. Запускаю всех тиммейтов параллельно.' }],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].text).toBe('Команда создана. Запускаю всех тиммейтов параллельно.');
    expect(live[0].source).toBe('lead_process');
    expect(live[0].messageId).toMatch(/^lead-turn-run-1-1$/);

    // Also still in provisioningOutputParts for the banner
    expect(run.provisioningOutputParts).toHaveLength(1);
  });

  it('emits lead-message event type (not inbox)', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    service.setTeamChangeEmitter(emitter);
    const run = attachRun(service, 'my-team', { provisioningComplete: false });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Launching teammates now.' }],
    });

    expect(emitter).toHaveBeenCalledTimes(1);
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead-message', teamName: 'my-team' })
    );
  });

  it('coalesces rapid emissions via LEAD_TEXT_EMIT_THROTTLE_MS', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    service.setTeamChangeEmitter(emitter);
    const run = attachRun(service, 'my-team', { provisioningComplete: false });

    // First message: should emit
    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Message 1' }],
    });
    expect(emitter).toHaveBeenCalledTimes(1);

    // Second message immediately after: should be coalesced (not emitted again)
    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Message 2' }],
    });
    expect(emitter).toHaveBeenCalledTimes(1); // Still 1

    // Messages are still cached though
    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(2);
  });

  it('early live messages carry toolCalls and toolSummary', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: false });

    // First: tool_use message (no text)
    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'TeamCreate',
          input: { team_name: 'super-team', description: 'test' },
        },
      ],
    });

    // Then: text message — should pick up pending tool calls
    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Team created successfully.' }],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].toolCalls).toBeDefined();
    expect(live[0].toolCalls).toHaveLength(1);
    expect(live[0].toolCalls![0].name).toBe('TeamCreate');
    expect(live[0].toolSummary).toBeDefined();
  });

  it('provisioning-time SendMessage(to:user) is captured and persisted', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: false });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'user',
            content: 'All teammates online!',
            summary: 'Team ready',
          },
        },
      ],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].to).toBe('user');
    expect(live[0].text).toBe('All teammates online!');
    expect(live[0].source).toBe('lead_process');

    // Also persisted to sentMessages.json
    expect(hoisted.appendSentMessage).toHaveBeenCalledTimes(1);
  });

  it('captures SendMessage(to:team-lead) without rendering duplicate assistant thought text', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Forwarding the clarification request now.' },
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'team-lead',
            content: 'Need clarification on #abcd1234',
            summary: 'Clarification request',
          },
        },
      ],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].to).toBe('team-lead');
    expect(live[0].text).toBe('Need clarification on #abcd1234');
    expect(live[0].source).toBe('lead_process');
    // Non-user recipient → delivered to inbox, not sentMessages
    expect(hoisted.sendInboxMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.appendSentMessage).not.toHaveBeenCalled();
  });

  it('post-ready path also uses the unified helper', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    service.setTeamChangeEmitter(emitter);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Assigning tasks now.' }],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].source).toBe('lead_process');

    // Post-ready also emits lead-message
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lead-message', teamName: 'my-team' })
    );
  });

  it('SendMessage(to:teammate) creates inbox row and emits inbox detail for recipient', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    service.setTeamChangeEmitter(emitter);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'alice',
            content: 'Please check the migration.',
            summary: 'Migration check',
          },
        },
      ],
    });

    // Delivered to recipient inbox, not sentMessages
    expect(hoisted.sendInboxMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.sendInboxMessage).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({ member: 'alice' })
    );
    expect(hoisted.appendSentMessage).not.toHaveBeenCalled();

    // Emits inbox event for the specific recipient
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inbox',
        teamName: 'my-team',
        detail: 'inboxes/alice.json',
      })
    );
  });

  it('SendMessage(to:user) still persists to sentMessages.json', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    service.setTeamChangeEmitter(emitter);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'user',
            content: 'Task completed!',
            summary: 'Done',
          },
        },
      ],
    });

    expect(hoisted.appendSentMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.sendInboxMessage).not.toHaveBeenCalled();

    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inbox',
        teamName: 'my-team',
        detail: 'sentMessages.json',
      })
    );
  });

  it('upgrades qualified SendMessage recipients into cross-team sends', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    const crossTeamSender = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'cross-1' }));
    service.setTeamChangeEmitter(emitter);
    service.setCrossTeamSender(crossTeamSender);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });
    run.activeCrossTeamReplyHints = [{ toTeam: 'team-best', conversationId: 'conv-123' }];

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'team-best.user',
            content: 'Привет!',
            summary: 'Ответ',
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(crossTeamSender).toHaveBeenCalledTimes(1);
    });

    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTeam: 'my-team',
        fromMember: 'team-lead',
        toTeam: 'team-best',
        text: 'Привет!',
        conversationId: 'conv-123',
        replyToConversationId: 'conv-123',
      })
    );

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].source).toBe('cross_team_sent');
    expect(live[0].to).toBe('team-best.user');
    expect(live[0].text).toBe('Привет!');
    expect(hoisted.sendInboxMessage).not.toHaveBeenCalled();
    expect(hoisted.appendSentMessage).not.toHaveBeenCalled();
  });

  it('upgrades pseudo cross-team recipients into cross-team sends', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const crossTeamSender = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'cross-2' }));
    service.setCrossTeamSender(crossTeamSender);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'cross-team:team-best',
            content: 'Привет команде!',
            summary: 'Приветствие',
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(crossTeamSender).toHaveBeenCalledTimes(1);
    });

    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTeam: 'my-team',
        fromMember: 'team-lead',
        toTeam: 'team-best',
        text: 'Привет команде!',
      })
    );

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].source).toBe('cross_team_sent');
    expect(live[0].to).toBe('cross-team:team-best');
    expect(hoisted.sendInboxMessage).not.toHaveBeenCalled();
  });

  it('does not push a duplicate live row when cross-team fallback deduplicates', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const emitter = vi.fn<(event: TeamChangeEvent) => void>();
    const crossTeamSender = vi.fn(async () => ({
      deliveredToInbox: true,
      messageId: 'existing-cross-1',
      deduplicated: true,
    }));
    service.setTeamChangeEmitter(emitter);
    service.setCrossTeamSender(crossTeamSender);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'team-best.user',
            content: 'Повтор без нового live row',
            summary: 'Повтор',
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(crossTeamSender).toHaveBeenCalledTimes(1);
    });

    expect(service.getLiveLeadProcessMessages('my-team')).toHaveLength(0);
    expect(emitter).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead-message',
        teamName: 'my-team',
        detail: 'cross-team-send',
      })
    );
  });

  it('does not upgrade dotted local teammate names into cross-team sends', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const crossTeamSender = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'cross-1' }));
    service.setCrossTeamSender(crossTeamSender);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });
    run.request.members.push({ name: 'ops.bot', role: 'Specialist' });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'ops.bot',
            content: 'Please verify the rollout.',
            summary: 'Verify rollout',
          },
        },
      ],
    });

    expect(crossTeamSender).not.toHaveBeenCalled();
    expect(hoisted.sendInboxMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.sendInboxMessage).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({ member: 'ops.bot' })
    );
  });
});
