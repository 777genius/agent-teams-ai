import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLiveLeadMessagePortsBoundary,
  type TeamProvisioningLiveLeadMessagePortsFactoryRun,
} from '../TeamProvisioningLiveLeadMessagePortsFactory';

import type { InboxMessage, TeamChangeEvent } from '@shared/types';

function createRun(
  overrides: Partial<TeamProvisioningLiveLeadMessagePortsFactoryRun> = {}
): TeamProvisioningLiveLeadMessagePortsFactoryRun {
  return {
    teamName: 'alpha',
    runId: 'run-1',
    request: {
      members: [
        { name: 'lead', role: 'lead' },
        { name: 'worker', role: 'teammate' },
      ],
    },
    activeCrossTeamReplyHints: [],
    pendingDirectCrossTeamSendRefresh: false,
    silentUserDmForward: null,
    pendingInboxRelayCandidates: [],
    leadMsgSeq: 0,
    liveLeadTextBuffer: null,
    pendingToolCalls: [],
    lastLeadTextEmitMs: 0,
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map(),
    stallWarningIndex: null,
    apiRetryWarningIndex: null,
    detectedSessionId: null,
    ...overrides,
  };
}

describe('TeamProvisioningLiveLeadMessagePortsFactory', () => {
  it('wires live lead process and text helpers to shared provisioning state', () => {
    const run = createRun({ detectedSessionId: 'session-1' });
    const runs = new Map([[run.runId, run]]);
    const liveLeadProcessMessages = new Map<string, InboxMessage[]>();
    const emitted: TeamChangeEvent[] = [];
    const ports = createTeamProvisioningLiveLeadMessagePortsBoundary({
      liveLeadProcessMessages,
      getTrackedRunId: () => run.runId,
      getAliveRunId: () => run.runId,
      getRun: (runId) => runs.get(runId),
      getRunLeadName: () => 'lead',
      getCrossTeamSender: () => null,
      persistSentMessage: vi.fn(),
      persistInboxMessage: vi.fn(),
      emitTeamChange: (event) => emitted.push(event),
      logger: { debug: vi.fn(), warn: vi.fn() },
      nowIso: () => '2026-01-01T00:00:00.000Z',
      nowMs: () => 5_000,
      cacheLimit: 5,
      leadTextEmitThrottleMs: 2_000,
    });

    ports.pushLiveLeadProcessMessage('alpha', {
      from: 'lead',
      text: 'cached',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: true,
      messageId: 'manual-1',
      source: 'lead_process',
      leadSessionId: 'outside-session',
    });
    ports.pushLiveLeadTextMessage(run, 'streamed', undefined, undefined, {
      coalesceStreamChunk: true,
    });

    expect(ports.getCurrentLeadSessionId('alpha')).toBe('session-1');
    expect(ports.getLiveLeadProcessMessages('alpha')).toEqual([
      expect.objectContaining({ messageId: 'manual-1', leadSessionId: 'outside-session' }),
      expect.objectContaining({
        messageId: 'lead-turn-run-1-1',
        text: 'streamed',
        leadSessionId: 'session-1',
      }),
    ]);
    expect(emitted).toEqual([
      { type: 'lead-message', teamName: 'alpha', runId: 'run-1', detail: 'lead-text' },
    ]);

    ports.pruneLiveLeadMessagesForCleanedRun(run);

    expect(liveLeadProcessMessages.get('alpha')).toEqual([
      expect.objectContaining({ messageId: 'manual-1' }),
    ]);
  });

  it('captures send messages through service persistence and current cross-team sender ports', async () => {
    const run = createRun({
      activeCrossTeamReplyHints: [{ toTeam: 'beta', conversationId: 'conversation-1' }],
    });
    const runs = new Map([[run.runId, run]]);
    const liveLeadProcessMessages = new Map<string, InboxMessage[]>();
    const sent: InboxMessage[] = [];
    const inbox: Array<{ recipient: string; message: InboxMessage }> = [];
    const emitted: TeamChangeEvent[] = [];
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    let nowMs = 5_000;
    const ports = createTeamProvisioningLiveLeadMessagePortsBoundary({
      liveLeadProcessMessages,
      getTrackedRunId: () => run.runId,
      getAliveRunId: () => run.runId,
      getRun: (runId) => runs.get(runId),
      getRunLeadName: () => 'lead',
      getCrossTeamSender: () => crossTeamSender,
      persistSentMessage: (_teamName, message) => sent.push(message),
      persistInboxMessage: (_teamName, recipient, message) => inbox.push({ recipient, message }),
      emitTeamChange: (event) => emitted.push(event),
      logger: { debug: vi.fn(), warn: vi.fn() },
      nowIso: () => '2026-01-01T00:00:00.000Z',
      nowMs: () => nowMs++,
      cacheLimit: 5,
      leadTextEmitThrottleMs: 2_000,
    });

    ports.captureSendMessages(run, [
      {
        type: 'tool_use',
        name: 'SendMessage',
        input: { recipient: 'user', content: 'hello user', summary: 'hello' },
      },
      {
        type: 'tool_use',
        name: 'SendMessage',
        input: { recipient: 'worker', content: 'hello worker', summary: 'worker' },
      },
      {
        type: 'tool_use',
        name: 'SendMessage',
        input: { recipient: 'beta.lead', content: 'hello beta', summary: 'beta' },
      },
    ]);
    await Promise.resolve();

    expect(sent).toEqual([expect.objectContaining({ to: 'user', text: 'hello user' })]);
    expect(inbox).toEqual([
      {
        recipient: 'worker',
        message: expect.objectContaining({ to: 'worker', text: 'hello worker' }),
      },
    ]);
    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTeam: 'alpha',
        toTeam: 'beta',
        conversationId: 'conversation-1',
        replyToConversationId: 'conversation-1',
      })
    );
    expect(ports.resolveCrossTeamReplyMetadata('alpha', 'beta')).toEqual({
      conversationId: 'conversation-1',
      replyToConversationId: 'conversation-1',
    });
    expect(ports.getLiveLeadProcessMessages('alpha')).toEqual([
      expect.objectContaining({ to: 'user', text: 'hello user' }),
      expect.objectContaining({ to: 'worker', text: 'hello worker' }),
      expect.objectContaining({ to: 'beta.lead', source: 'cross_team_sent' }),
    ]);
    expect(emitted).toEqual([
      { type: 'inbox', teamName: 'alpha', detail: 'sentMessages.json' },
      { type: 'inbox', teamName: 'alpha', detail: 'inboxes/worker.json' },
      {
        type: 'lead-message',
        teamName: 'alpha',
        runId: 'run-1',
        detail: 'cross-team-send',
      },
    ]);
  });
});
