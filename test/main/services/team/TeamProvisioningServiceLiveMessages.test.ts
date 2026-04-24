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

vi.mock('../../../../src/main/services/team/fileLock', () => ({
  withFileLock: async (_filePath: string, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock('../../../../src/main/services/team/inboxLock', () => ({
  withInboxLock: async (_filePath: string, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock('../../../../src/main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/pathDecoder')>();
  return { ...actual, getTeamsBasePath: () => '/mock/teams' };
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

import type { TeamChangeEvent } from '@shared/types/team';
import { ConfigManager } from '../../../../src/main/services/infrastructure/ConfigManager';
import {
  clearAutoResumeService,
  getAutoResumeService,
  initializeAutoResumeService,
} from '../../../../src/main/services/team/AutoResumeService';
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

interface RunLike {
  runId: string;
  teamName: string;
  provisioningComplete: boolean;
  detectedSessionId?: string | null;
  leadMsgSeq: number;
  pendingToolCalls: { name: string; preview: string }[];
  activeToolCalls: Map<string, unknown>;
  pendingDirectCrossTeamSendRefresh: boolean;
  lastLeadTextEmitMs: number;
  leadRelayCapture: null;
  silentUserDmForward:
    | null
    | { target: string; startedAt: string; mode: 'user_dm' | 'member_inbox_relay' };
  suppressPostCompactReminderOutput?: boolean;
  child: Record<string, unknown> | null;
  processKilled: boolean;
  cancelRequested: boolean;
  provisioningOutputParts: string[];
  request: { members: { name: string; role?: string }[] };
  activeCrossTeamReplyHints?: Array<{ toTeam: string; conversationId: string }>;
  pendingInboxRelayCandidates?: unknown[];
  memberSpawnStatuses: Map<string, unknown>;
  pendingApprovals: Map<string, unknown>;
}

/**
 * Attach a run to the service internals. `provisioningComplete` defaults to false
 * (pre-ready) to test the early message pipeline.
 */
function attachRun(
  service: TeamProvisioningService,
  teamName: string,
  opts?: { provisioningComplete?: boolean; runId?: string; detectedSessionId?: string | null }
): RunLike {
  const runId = opts?.runId ?? 'run-1';
  const run: RunLike = {
    runId,
    teamName,
    provisioningComplete: opts?.provisioningComplete ?? false,
    detectedSessionId: opts?.detectedSessionId ?? null,
    leadMsgSeq: 0,
    pendingToolCalls: [],
    activeToolCalls: new Map(),
    pendingDirectCrossTeamSendRefresh: false,
    lastLeadTextEmitMs: 0,
    leadRelayCapture: null,
    silentUserDmForward: null,
    pendingInboxRelayCandidates: [],
    child: { stdin: { writable: true, write: vi.fn(), end: vi.fn() } },
    processKilled: false,
    cancelRequested: false,
    provisioningOutputParts: [],
    request: { members: [{ name: 'team-lead', role: 'Team Lead' }] },
    activeCrossTeamReplyHints: [],
    memberSpawnStatuses: new Map(),
    pendingApprovals: new Map(),
  };

  (service as unknown as { aliveRunByTeam: Map<string, string> }).aliveRunByTeam.set(
    teamName,
    runId
  );
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

  it('attaches leadSessionId to a live message when the same assistant payload carries session_id', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: false });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      session_id: 'sess-123',
      content: [{ type: 'text', text: 'Команда создана. Запускаю всех тиммейтов параллельно.' }],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].leadSessionId).toBe('sess-123');
  });

  it('makes leadSessionId visible to synchronous lead-message listeners in the same turn', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const seenSessionIds: Array<string | undefined> = [];
    service.setTeamChangeEmitter((event) => {
      if (event.type === 'lead-message') {
        seenSessionIds.push(service.getLiveLeadProcessMessages('my-team')[0]?.leadSessionId);
      }
    });
    const run = attachRun(service, 'my-team', { provisioningComplete: false });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      session_id: 'sess-sync',
      content: [{ type: 'text', text: 'Команда создана. Запускаю всех тиммейтов параллельно.' }],
    });

    expect(seenSessionIds).toEqual(['sess-sync']);
  });

  it('retrofits leadSessionId onto earlier live messages after session detection', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: false });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Команда создана. Запускаю всех тиммейтов параллельно.' }],
    });
    expect(service.getLiveLeadProcessMessages('my-team')[0]?.leadSessionId).toBeUndefined();

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      session_id: 'sess-456',
      content: [],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].leadSessionId).toBe('sess-456');
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

  it('suppresses duplicate assistant thought text when SendMessage targets a teammate', () => {
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

  it('suppresses duplicate assistant thought text when SendMessage targets user', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Task completed. Sending the summary now.' },
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'user',
            content: 'Task completed successfully.',
            summary: 'Done',
          },
        },
      ],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].to).toBe('user');
    expect(live[0].text).toBe('Task completed successfully.');
    expect(live[0].source).toBe('lead_process');
    expect(hoisted.appendSentMessage).toHaveBeenCalledTimes(1);
  });

  it('suppresses duplicate assistant thought text when Agent Teams message_send is already visible', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Sending this through the Agent Teams MCP tool now.' },
        {
          type: 'tool_use',
          name: 'mcp__agent-teams__message_send',
          input: {
            teamName: 'my-team',
            to: 'user',
            text: 'Task completed through MCP.',
            from: 'team-lead',
            summary: 'Done',
          },
        },
      ],
    });

    // The MCP controller owns persistence for agent-teams_message_send. The stream
    // capture path must not show the assistant narration as a second "thought".
    expect(service.getLiveLeadProcessMessages('my-team')).toHaveLength(0);
    expect(hoisted.appendSentMessage).not.toHaveBeenCalled();
  });

  it('keeps assistant thought text when Agent Teams message_send payload is incomplete', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        { type: 'text', text: 'I need to retry this because the tool input is incomplete.' },
        {
          type: 'tool_use',
          name: 'mcp__agent-teams__message_send',
          input: {
            teamName: 'my-team',
            to: 'user',
            from: 'team-lead',
            summary: 'Incomplete',
          },
        },
      ],
    });

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].text).toBe('I need to retry this because the tool input is incomplete.');
    expect(live[0].source).toBe('lead_process');
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
    expect(live[0].from).toBe('team-lead');
    expect(live[0].source).toBe('cross_team_sent');
    expect(live[0].to).toBe('team-best.user');
    expect(live[0].text).toBe('Привет!');
    expect(hoisted.sendInboxMessage).not.toHaveBeenCalled();
    expect(hoisted.appendSentMessage).not.toHaveBeenCalled();
  });

  it('ignores stale cross-team send completions from an older run after a new run starts', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');

    let resolveSend: ((value: { deliveredToInbox: boolean; messageId: string }) => void) | null =
      null;
    const crossTeamSender = vi.fn(
      () =>
        new Promise<{ deliveredToInbox: boolean; messageId: string }>((resolve) => {
          resolveSend = resolve;
        })
    );
    service.setCrossTeamSender(crossTeamSender);

    const oldRun = attachRun(service, 'my-team', {
      provisioningComplete: true,
      runId: 'run-old',
      detectedSessionId: 'sess-old',
    });
    oldRun.activeCrossTeamReplyHints = [{ toTeam: 'team-best', conversationId: 'conv-old' }];

    callHandleStreamJsonMessage(service, oldRun, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'team-best.user',
            content: 'Old run cross-team reply.',
            summary: 'Old run reply',
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(crossTeamSender).toHaveBeenCalledTimes(1);
    });

    const newRun = attachRun(service, 'my-team', {
      provisioningComplete: true,
      runId: 'run-new',
      detectedSessionId: 'sess-new',
    });
    service.pushLiveLeadProcessMessage('my-team', {
      from: 'team-lead',
      text: 'Current run is active.',
      timestamp: '2026-04-17T12:00:10.000Z',
      read: true,
      source: 'lead_process',
      messageId: 'lead-turn-run-new-1',
      leadSessionId: 'sess-new',
    });

    expect(resolveSend).not.toBeNull();
    const finishSend = resolveSend as unknown as ((
      value: { deliveredToInbox: boolean; messageId: string }
    ) => void);
    finishSend({ deliveredToInbox: true, messageId: 'cross-stale-old-run' });
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getLiveLeadProcessMessages('my-team')).toEqual([
      expect.objectContaining({
        text: 'Current run is active.',
        messageId: 'lead-turn-run-new-1',
        leadSessionId: 'sess-new',
      }),
    ]);

    (service as unknown as { cleanupRun: (runLike: unknown) => void }).cleanupRun(oldRun);
    (service as unknown as { cleanupRun: (runLike: unknown) => void }).cleanupRun(newRun);
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
    expect(live[0].from).toBe('team-lead');
    expect(live[0].source).toBe('cross_team_sent');
    expect(live[0].to).toBe('cross-team:team-best');
    expect(hoisted.sendInboxMessage).not.toHaveBeenCalled();
  });

  it('upgrades MCP message_send pseudo recipients into cross-team sends', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const crossTeamSender = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'cross-mcp-1' }));
    service.setCrossTeamSender(crossTeamSender);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });
    run.activeCrossTeamReplyHints = [{ toTeam: 'team-best', conversationId: 'conv-mcp-1' }];
    const taskRefs = [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'my-team' }];

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'mcp__agent-teams__message_send',
          input: {
            teamName: 'my-team',
            to: 'cross-team:team-best',
            text: 'Ответ через MCP.',
            from: 'team-lead',
            summary: 'MCP reply',
            taskRefs,
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
        text: 'Ответ через MCP.',
        conversationId: 'conv-mcp-1',
        replyToConversationId: 'conv-mcp-1',
        taskRefs,
      })
    );

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].from).toBe('team-lead');
    expect(live[0].source).toBe('cross_team_sent');
    expect(live[0].to).toBe('cross-team:team-best');
    expect(live[0].taskRefs).toEqual(taskRefs);
    expect(hoisted.sendInboxMessage).not.toHaveBeenCalled();
  });

  it('refreshes sentMessages history after direct MCP cross_team_send succeeds', () => {
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
          name: 'mcp__agent-teams__cross_team_send',
          input: {
            teamName: 'my-team',
            toTeam: 'team-best',
            text: 'Прямой вызов MCP.',
            summary: 'Direct MCP send',
          },
        },
      ],
    });

    expect(run.pendingDirectCrossTeamSendRefresh).toBe(true);

    callHandleStreamJsonMessage(service, run, {
      type: 'result',
      subtype: 'success',
    });

    expect(run.pendingDirectCrossTeamSendRefresh).toBe(false);
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inbox',
        teamName: 'my-team',
        detail: 'sentMessages.json',
      })
    );
  });

  it('marks native cross-team teammate-message deliveries as read and restores reply hints', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    seedLeadInbox('my-team', [
      {
        from: 'other-team.team-lead',
        to: 'team-lead',
        text: '<cross-team from="other-team.team-lead" depth="0" conversationId="conv-native-1" replyToConversationId="conv-native-1" />\nНативная доставка.',
        timestamp: '2026-02-23T10:01:00.000Z',
        read: false,
        source: 'cross_team',
        messageId: 'm-native-cross-team-1',
        conversationId: 'conv-native-1',
        replyToConversationId: 'conv-native-1',
      },
    ]);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'user',
      message: {
        role: 'user',
        content:
          '<teammate-message teammate_id="other-team.team-lead" color="purple" summary="Cross-team reply"><cross-team from="other-team.team-lead" depth="0" conversationId="conv-native-1" replyToConversationId="conv-native-1" />\nНативная доставка.</teammate-message>',
      },
    });

    await vi.waitFor(() => {
      const updatedInbox = JSON.parse(
        hoisted.files.get('/mock/teams/my-team/inboxes/team-lead.json') ?? '[]'
      ) as Array<{ read?: boolean }>;
      expect(updatedInbox[0]?.read).toBe(true);
    });

    expect(run.activeCrossTeamReplyHints).toEqual([
      { toTeam: 'other-team', conversationId: 'conv-native-1' },
    ]);
  });

  it('suppresses native duplicate cross-team teammate-message after recent relay delivery', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const content =
      '<cross-team from="other-team.team-lead" depth="0" conversationId="conv-native-dup" replyToConversationId="conv-native-dup" />\nПовторная доставка.';
    seedLeadInbox('my-team', [
      {
        from: 'other-team.team-lead',
        to: 'team-lead',
        text: content,
        timestamp: '2026-03-10T21:43:00.000Z',
        read: false,
        source: 'cross_team',
        messageId: 'm-native-cross-team-dup',
        conversationId: 'conv-native-dup',
        replyToConversationId: 'conv-native-dup',
      },
    ]);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    (service as any).rememberRecentCrossTeamLeadDeliveryMessageIds('my-team', [
      'm-native-cross-team-dup',
    ]);

    callHandleStreamJsonMessage(service, run, {
      type: 'user',
      message: {
        role: 'user',
        content: `<teammate-message teammate_id="other-team.team-lead" color="purple" summary="Cross-team reply">${content}</teammate-message>`,
      },
    });

    await vi.waitFor(() => {
      const updatedInbox = JSON.parse(
        hoisted.files.get('/mock/teams/my-team/inboxes/team-lead.json') ?? '[]'
      ) as Array<{ read?: boolean }>;
      expect(updatedInbox[0]?.read).toBe(true);
    });

    expect(run.activeCrossTeamReplyHints).toEqual([]);
  });

  it('rescues mistaken cross_team_send recipients into actual cross-team replies', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const crossTeamSender = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'cross-mcp-tool-1' }));
    service.setCrossTeamSender(crossTeamSender);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });
    run.activeCrossTeamReplyHints = [{ toTeam: 'team-best', conversationId: 'conv-tool-1' }];

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'mcp__agent-teams__message_send',
          input: {
            teamName: 'my-team',
            to: 'cross_team_send',
            text: 'Исправленный ответ.',
            from: 'team-lead',
            summary: 'Ответ через tool recipient mistake',
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
        text: 'Исправленный ответ.',
        conversationId: 'conv-tool-1',
        replyToConversationId: 'conv-tool-1',
      })
    );

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].from).toBe('team-lead');
    expect(live[0].source).toBe('cross_team_sent');
    expect(live[0].to).toBe('team-best.team-lead');
    expect(hoisted.sendInboxMessage).not.toHaveBeenCalled();
  });

  it('rescues cross_team::team pseudo recipients into actual cross-team replies', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const crossTeamSender = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'cross-colon-1' }));
    service.setCrossTeamSender(crossTeamSender);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'mcp__agent-teams__message_send',
          input: {
            teamName: 'my-team',
            to: 'cross_team::team-best',
            text: 'Ответ через fallback pseudo recipient.',
            summary: 'Fallback pseudo reply',
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
        text: 'Ответ через fallback pseudo recipient.',
      })
    );

    const live = service.getLiveLeadProcessMessages('my-team');
    expect(live).toHaveLength(1);
    expect(live[0].source).toBe('cross_team_sent');
    expect(live[0].to).toBe('team-best.team-lead');
    expect(hoisted.sendInboxMessage).not.toHaveBeenCalled();
  });

  it('strips canonical cross-team tag from outbound cross-team content', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const crossTeamSender = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'cross-legacy' }));
    service.setCrossTeamSender(crossTeamSender);
    const run = attachRun(service, 'my-team', { provisioningComplete: true });
    run.activeCrossTeamReplyHints = [{ toTeam: 'team-best', conversationId: 'conv-legacy' }];

    callHandleStreamJsonMessage(service, run, {
      type: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: {
            type: 'message',
            recipient: 'team-best.user',
            content:
              '<cross-team from="my-team.team-lead" depth="0" conversationId="conv-legacy" replyToConversationId="conv-legacy" />\nПривет!',
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
        text: 'Привет!',
        conversationId: 'conv-legacy',
        replyToConversationId: 'conv-legacy',
      })
    );
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

describe('TeamProvisioningService auto-resume cleanup', () => {
  beforeEach(() => {
    hoisted.files.clear();
    hoisted.appendSentMessage.mockClear();
    hoisted.sendInboxMessage.mockClear();
    clearAutoResumeService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAutoResumeService();
    vi.useRealTimers();
  });

  it('cancels pending auto-resume timers when a run is cleaned up', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', { provisioningComplete: true });

    const autoResumeProvisioning = {
      getCurrentRunId: vi.fn(() => 'run-1' as string | null),
      isTeamAlive: vi.fn(() => true),
      sendMessageToTeam: vi.fn(async () => undefined),
    };
    initializeAutoResumeService(autoResumeProvisioning);

    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      getAutoResumeService().handleRateLimitMessage(
        'my-team',
        "You've hit your limit. Resets in 5 minutes.",
        new Date('2026-04-17T12:00:00.000Z')
      );

      (service as unknown as { cleanupRun: (runLike: unknown) => void }).cleanupRun(run);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30 * 1000 + 100);
      expect(autoResumeProvisioning.sendMessageToTeam).not.toHaveBeenCalled();
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('does not let stale cleanup from an older run cancel the current run state', async () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const oldRun = attachRun(service, 'my-team', {
      provisioningComplete: true,
      runId: 'run-old',
      detectedSessionId: 'sess-old',
    });
    const newRun = attachRun(service, 'my-team', {
      provisioningComplete: true,
      runId: 'run-new',
      detectedSessionId: 'sess-new',
    });

    const autoResumeProvisioning = {
      getCurrentRunId: vi.fn(() => 'run-1' as string | null),
      isTeamAlive: vi.fn(() => true),
      sendMessageToTeam: vi.fn(async () => undefined),
    };
    initializeAutoResumeService(autoResumeProvisioning);

    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      getAutoResumeService().handleRateLimitMessage(
        'my-team',
        "You've hit your limit. Resets in 5 minutes.",
        new Date('2026-04-17T12:00:00.000Z')
      );

      service.pushLiveLeadProcessMessage('my-team', {
        from: 'team-lead',
        text: 'Current run is active.',
        timestamp: '2026-04-17T12:00:01.000Z',
        read: true,
        source: 'lead_process',
        messageId: 'live-new-run',
      });
      expect(service.getLiveLeadProcessMessages('my-team')).toHaveLength(1);

      (service as unknown as { cleanupRun: (runLike: unknown) => void }).cleanupRun(oldRun);

      expect(service.getLiveLeadProcessMessages('my-team')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30 * 1000 + 100);
      expect(autoResumeProvisioning.sendMessageToTeam).toHaveBeenCalledTimes(1);
      expect(autoResumeProvisioning.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('rate limit has reset')
      );
    } finally {
      getConfigSpy.mockRestore();
      (service as unknown as { cleanupRun: (runLike: unknown) => void }).cleanupRun(newRun);
    }
  });

  it('removes stale live lead messages from an older run while preserving the current run', () => {
    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const oldRun = attachRun(service, 'my-team', {
      provisioningComplete: true,
      runId: 'run-old',
      detectedSessionId: 'sess-old',
    });

    service.pushLiveLeadProcessMessage('my-team', {
      from: 'team-lead',
      text: "You've hit your limit. Resets in 5 minutes.",
      timestamp: '2026-04-17T12:00:00.000Z',
      read: true,
      source: 'lead_process',
      messageId: 'lead-turn-run-old-1',
      leadSessionId: 'sess-old',
    });

    const newRun = attachRun(service, 'my-team', {
      provisioningComplete: true,
      runId: 'run-new',
      detectedSessionId: 'sess-new',
    });

    service.pushLiveLeadProcessMessage('my-team', {
      from: 'team-lead',
      text: 'Current run is active.',
      timestamp: '2026-04-17T12:00:10.000Z',
      read: true,
      source: 'lead_process',
      messageId: 'lead-turn-run-new-1',
      leadSessionId: 'sess-new',
    });

    expect(service.getLiveLeadProcessMessages('my-team')).toHaveLength(2);

    (service as unknown as { cleanupRun: (runLike: unknown) => void }).cleanupRun(oldRun);

    expect(service.getLiveLeadProcessMessages('my-team')).toEqual([
      expect.objectContaining({
        text: 'Current run is active.',
        messageId: 'lead-turn-run-new-1',
        leadSessionId: 'sess-new',
      }),
    ]);

    (service as unknown as { cleanupRun: (runLike: unknown) => void }).cleanupRun(newRun);
  });

  it('preserves the canonical assistant timestamp for live rate-limit messages', async () => {
    vi.setSystemTime(new Date('2026-04-17T12:00:20.000Z'));

    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', {
      provisioningComplete: true,
      detectedSessionId: 'sess-live',
    });

    const autoResumeProvisioning = {
      getCurrentRunId: vi.fn(() => 'run-1' as string | null),
      isTeamAlive: vi.fn(() => true),
      sendMessageToTeam: vi.fn(async () => undefined),
    };
    initializeAutoResumeService(autoResumeProvisioning);

    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      callHandleStreamJsonMessage(service, run, {
        type: 'assistant',
        timestamp: '2026-04-17T12:00:00.000Z',
        content: [{ type: 'text', text: "You've hit your limit. Resets in 5 minutes." }],
      });

      const live = service.getLiveLeadProcessMessages('my-team');
      expect(live).toHaveLength(1);
      expect(live[0].timestamp).toBe('2026-04-17T12:00:00.000Z');

      getAutoResumeService().handleRateLimitMessage(
        'my-team',
        live[0].text,
        new Date('2026-04-17T12:00:20.000Z'),
        new Date(live[0].timestamp)
      );

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 9 * 1000);
      expect(autoResumeProvisioning.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      expect(autoResumeProvisioning.sendMessageToTeam).toHaveBeenCalledTimes(1);
      expect(autoResumeProvisioning.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('rate limit has reset')
      );
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('schedules auto-resume from api_retry model_cooldown payloads during provisioning', async () => {
    vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));

    const service = new TeamProvisioningService();
    seedConfig('my-team');
    const run = attachRun(service, 'my-team', {
      provisioningComplete: false,
      detectedSessionId: 'sess-live',
    });
    (run as unknown as { progress: Record<string, unknown> }).progress = {
      state: 'starting',
      updatedAt: '2026-04-17T12:00:00.000Z',
    };
    const onProgress = vi.fn();
    (run as unknown as { onProgress: (progress: unknown) => void }).onProgress = onProgress;

    const autoResumeProvisioning = {
      getCurrentRunId: vi.fn(() => 'run-1' as string | null),
      isTeamAlive: vi.fn(() => true),
      sendMessageToTeam: vi.fn(async () => undefined),
    };
    initializeAutoResumeService(autoResumeProvisioning);

    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      callHandleStreamJsonMessage(service, run, {
        type: 'system',
        subtype: 'api_retry',
        timestamp: '2026-04-17T12:00:00.000Z',
        attempt: 1,
        max_retries: 10,
        error_status: 429,
        error: 'model_cooldown',
        error_message:
          '429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-4-6 are cooling down via provider claude","model":"claude-opus-4-6","provider":"claude","reset_seconds":41,"reset_time":"40s"}}',
        retry_delay_ms: 41_000,
      });

      expect(onProgress).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(41 * 1000 + 29 * 1000);
      expect(autoResumeProvisioning.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      expect(autoResumeProvisioning.sendMessageToTeam).toHaveBeenCalledTimes(1);
      expect(autoResumeProvisioning.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('rate limit has reset')
      );
    } finally {
      getConfigSpy.mockRestore();
    }
  });
});
