import { validateMessageId } from '@main/ipc/guards';
import { describe, expect, it, vi } from 'vitest';

import {
  captureLeadSendMessages,
  dropUnsettledLeadSendMessages,
  type TeamProvisioningLeadSendMessageCapturePorts,
  type TeamProvisioningLeadSendMessageRun,
} from '../TeamProvisioningLeadSendMessageCapture';

import type { InboxMessage } from '@shared/types';

function createRun(
  overrides: Partial<TeamProvisioningLeadSendMessageRun> = {}
): TeamProvisioningLeadSendMessageRun {
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
    pendingLeadSendMessages: new Map(),
    leadSendMessageSeq: 0,
    ...overrides,
  };
}

function createPorts(
  overrides: Partial<TeamProvisioningLeadSendMessageCapturePorts> = {}
): TeamProvisioningLeadSendMessageCapturePorts & {
  pushed: InboxMessage[];
  sent: InboxMessage[];
  inboxChanges: string[];
  leadChanges: string[];
} {
  const pushed: InboxMessage[] = [];
  const sent: InboxMessage[] = [];
  const inboxChanges: string[] = [];
  const leadChanges: string[] = [];
  return {
    pushed,
    sent,
    inboxChanges,
    leadChanges,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    crossTeamSender: null,
    resolveCrossTeamReplyMetadata: () => null,
    getTrackedRunId: () => 'run-1',
    pushLiveLeadProcessMessage: (_teamName, message) => pushed.push(message),
    persistSentMessage: (_teamName, message) => sent.push(message),
    emitLeadMessageChange: (_teamName, _runId, detail) => leadChanges.push(detail),
    emitInboxChange: (_teamName, detail) => inboxChanges.push(detail),
    ...overrides,
  };
}

function sendMessageCall(id: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: 'tool_use', id, name: 'SendMessage', input };
}

function toolResult(toolUseId: string, isError = false): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: isError ? 'UNKNOWN_RECIPIENT: nothing was sent.' : 'Message sent',
    is_error: isError,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('lead SendMessage capture helpers', () => {
  it('captures native SendMessage to the user and persists sent messages', () => {
    const run = createRun();
    const ports = createPorts();

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'user', content: 'Hello user', summary: 'Hi' })],
      ports
    );
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);

    expect(ports.pushed).toEqual([
      expect.objectContaining({
        from: 'team-lead',
        to: 'user',
        text: 'Hello user',
        messageId: 'lead-sendmsg-run-1-1-toolu-1',
      }),
    ]);
    expect(ports.sent).toHaveLength(1);
    expect(ports.inboxChanges).toEqual(['sentMessages.json']);
  });

  it('suppresses user SendMessage while relaying a member inbox', () => {
    const run = createRun({
      silentUserDmForward: {
        target: 'worker',
        mode: 'member_inbox_relay',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const ports = createPorts();

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'user', content: 'wrong recipient' })],
      ports
    );
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);

    expect(ports.pushed).toEqual([]);
    expect(ports.sent).toEqual([]);
    expect(ports.logger.debug).toHaveBeenCalledWith(
      '[alpha] Suppressed SendMessage→user during member_inbox_relay to "worker"'
    );
  });

  it('keeps a live copy of native SendMessage to a teammate without writing its inbox', () => {
    const run = createRun({
      pendingInboxRelayCandidates: [
        {
          recipient: 'worker',
          sourceMessageId: 'source-1',
          normalizedText: 'forwarded',
          normalizedSummary: '',
          queuedAtMs: Date.now(),
        },
      ],
    });
    const ports = createPorts();

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'worker', content: 'forwarded' })],
      ports
    );
    expect(ports.pushed).toEqual([]);
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);
    // A repeated result for the same call must not add a second copy.
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);

    expect(ports.pushed).toEqual([
      expect.objectContaining({
        to: 'worker',
        relayOfMessageId: 'source-1',
        messageId: 'lead-sendmsg-run-1-1-toolu-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        read: true,
        source: 'lead_process',
      }),
    ]);
    // The runtime is the single durable writer of teammate inboxes.
    expect(ports.inboxChanges).toEqual([]);
    expect(ports.leadChanges).toEqual(['lead-send-message']);
    expect(run.pendingInboxRelayCandidates).toEqual([]);
  });

  it('marks direct cross-team send tools for sent-message refresh', () => {
    const run = createRun();
    const ports = createPorts();

    captureLeadSendMessages(
      run,
      [
        {
          type: 'tool_use',
          name: 'mcp__agent_teams__cross_team_send',
          input: { toTeam: 'beta', text: 'hello' },
        },
      ],
      ports
    );

    expect(run.pendingDirectCrossTeamSendRefresh).toBe(true);
  });

  it('routes qualified recipients through the cross-team sender', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });

    captureLeadSendMessages(
      run,
      [
        sendMessageCall('toolu-1', {
          recipient: 'beta.worker',
          content: 'hello',
          summary: 'hello',
        }),
      ],
      ports
    );
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);
    await flushPromises();

    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTeam: 'alpha',
        fromMember: 'team-lead',
        toTeam: 'beta',
        toMember: 'worker',
        text: 'hello',
      })
    );
    expect(ports.pushed).toEqual([
      expect.objectContaining({
        to: 'beta.worker',
        source: 'cross_team_sent',
        messageId: 'cross-1',
      }),
    ]);
    expect(ports.leadChanges).toEqual(['cross-team-send']);
  });

  it('sends a SendMessage addressed to cross_team_send to the one team awaiting a reply', async () => {
    const run = createRun({
      activeCrossTeamReplyHints: [{ toTeam: 'beta', conversationId: 'conv-1' }],
    });
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'cross_team_send', content: 'reply' })],
      ports
    );
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);
    await flushPromises();

    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({
        toTeam: 'beta',
        toMember: 'team-lead',
        text: 'reply',
        conversationId: 'conv-1',
        replyToConversationId: 'conv-1',
      })
    );
    expect(ports.pushed).toEqual([
      expect.objectContaining({ to: 'beta.team-lead', source: 'cross_team_sent' }),
    ]);
  });

  it('sends a SendMessage addressed to cross_team::<team> to that team lead', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'cross_team::beta', content: 'reply' })],
      ports
    );
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);
    await flushPromises();

    expect(crossTeamSender).toHaveBeenCalledTimes(1);
    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({ toTeam: 'beta', toMember: 'team-lead', text: 'reply' })
    );
  });

  it('keeps message ids valid and unique for unusual or repeated tool_use ids', () => {
    const run = createRun();
    const ports = createPorts();
    const toolUseIds = ['item:0.a', 'item:0.a', `call.${'x'.repeat(200)}`];

    // Each id gets its own turn: a runtime may reuse tool_use ids across turns.
    for (const toolUseId of toolUseIds) {
      captureLeadSendMessages(
        run,
        [sendMessageCall(toolUseId, { recipient: 'worker', content: `hi ${toolUseId}` })],
        ports
      );
      captureLeadSendMessages(run, [toolResult(toolUseId)], ports);
    }

    const messageIds = ports.pushed.map((message) => message.messageId ?? '');
    expect(messageIds.slice(0, 2)).toEqual([
      'lead-sendmsg-run-1-1-item_0_a',
      'lead-sendmsg-run-1-2-item_0_a',
    ]);
    expect(new Set(messageIds).size).toBe(3);
    for (const messageId of messageIds) {
      expect(messageId.length).toBeLessThanOrEqual(128);
      expect(validateMessageId(messageId)).toMatchObject({ valid: true });
    }
  });

  it('ignores a SendMessage without a tool_use id because its result cannot be checked', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const ports = createPorts({ crossTeamSender, logger });

    captureLeadSendMessages(
      run,
      [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: { recipient: 'beta.worker', content: 'a' },
        },
        { type: 'tool_use', name: 'SendMessage', input: { recipient: 'worker', content: 'b' } },
      ],
      ports
    );
    await flushPromises();

    expect(crossTeamSender).not.toHaveBeenCalled();
    expect(ports.pushed).toEqual([]);
    expect(run.pendingLeadSendMessages.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('does not reroute agent-teams message_send to another team', async () => {
    const run = createRun({
      activeCrossTeamReplyHints: [{ toTeam: 'beta', conversationId: 'conv-1' }],
    });
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });

    // The board rejects these recipients, and the lead is told to use cross_team_send.
    captureLeadSendMessages(
      run,
      ['beta.worker', 'cross-team:beta', 'cross_team::beta', 'cross_team_send'].map((to, i) => ({
        type: 'tool_use',
        id: `toolu-${i}`,
        name: 'mcp__agent-teams__message_send',
        input: { teamName: 'alpha', to, text: 'hello', from: 'team-lead' },
      })),
      ports
    );
    captureLeadSendMessages(
      run,
      [0, 1, 2, 3].map((i) => toolResult(`toolu-${i}`)),
      ports
    );
    await flushPromises();

    expect(crossTeamSender).not.toHaveBeenCalled();
    expect(ports.pushed).toEqual([]);
    expect(run.pendingLeadSendMessages.size).toBe(0);
  });
});

describe('lead send calls wait for their tool result', () => {
  it('does not deliver a cross-team SendMessage before its tool result', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'beta.worker', content: 'hello', summary: 'hi' })],
      ports
    );
    await flushPromises();

    expect(crossTeamSender).not.toHaveBeenCalled();
    expect(ports.pushed).toEqual([]);
    expect(run.pendingLeadSendMessages.size).toBe(1);
  });

  it('does not deliver a cross-team SendMessage the runtime rejected', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'beta.worker', content: 'hello' })],
      ports
    );
    captureLeadSendMessages(run, [toolResult('toolu-1', true)], ports);
    await flushPromises();

    expect(crossTeamSender).not.toHaveBeenCalled();
    expect(ports.pushed).toEqual([]);
    expect(ports.leadChanges).toEqual([]);
    expect(run.pendingLeadSendMessages.size).toBe(0);
  });

  it('delivers a cross-team SendMessage once, with the captured request, after success', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'beta.worker', content: 'hello', summary: 'hi' })],
      ports
    );
    const captured = run.pendingLeadSendMessages.get('toolu-1');
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);
    // A repeated result for the same call must not send again.
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);
    await flushPromises();

    expect(captured?.kind).toBe('cross_team');
    expect(crossTeamSender).toHaveBeenCalledTimes(1);
    expect(crossTeamSender).toHaveBeenCalledWith(
      captured?.kind === 'cross_team' ? captured.request : undefined
    );
    expect(crossTeamSender).toHaveBeenCalledWith({
      fromTeam: 'alpha',
      fromMember: 'team-lead',
      toTeam: 'beta',
      toMember: 'worker',
      text: 'hello',
      summary: 'hi',
      messageId: 'lead-sendmsg-run-1-1-toolu-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      conversationId: undefined,
      replyToConversationId: undefined,
    });
    expect(ports.pushed).toEqual([
      expect.objectContaining({
        to: 'beta.worker',
        source: 'cross_team_sent',
        messageId: 'cross-1',
      }),
    ]);
    expect(ports.leadChanges).toEqual(['cross-team-send']);
    expect(run.pendingLeadSendMessages.size).toBe(0);
  });

  it('ignores a replayed tool_use while the call still waits for its result', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });
    const call = sendMessageCall('toolu-1', { recipient: 'beta.worker', content: 'hello' });

    captureLeadSendMessages(run, [call], ports);
    captureLeadSendMessages(run, [call], ports);
    captureLeadSendMessages(run, [toolResult('toolu-1')], ports);
    await flushPromises();

    expect(crossTeamSender).toHaveBeenCalledTimes(1);
  });

  it('settles parallel calls by tool_use id in any result order', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });

    captureLeadSendMessages(
      run,
      [
        sendMessageCall('toolu-a', { recipient: 'beta.worker', content: 'to beta' }),
        sendMessageCall('toolu-b', { recipient: 'wroker', content: 'typo' }),
        sendMessageCall('toolu-c', { recipient: 'user', content: 'to user' }),
      ],
      ports
    );
    captureLeadSendMessages(
      run,
      [toolResult('toolu-c'), toolResult('toolu-b', true), toolResult('toolu-a')],
      ports
    );
    await flushPromises();

    expect(crossTeamSender).toHaveBeenCalledTimes(1);
    expect(crossTeamSender).toHaveBeenCalledWith(expect.objectContaining({ text: 'to beta' }));
    expect(ports.pushed.map((message) => [message.to, message.messageId])).toEqual([
      ['user', 'lead-sendmsg-run-1-3-toolu-c'],
      ['beta.worker', 'cross-1'],
    ]);
    expect(ports.sent).toEqual([expect.objectContaining({ to: 'user', text: 'to user' })]);
    expect(run.pendingLeadSendMessages.size).toBe(0);
  });

  it('shows no live copy for a rejected teammate message and keeps its relay candidate', () => {
    const run = createRun({
      pendingInboxRelayCandidates: [
        {
          recipient: 'worker',
          sourceMessageId: 'source-1',
          normalizedText: 'forwarded',
          normalizedSummary: '',
          queuedAtMs: Date.now(),
        },
      ],
    });
    const ports = createPorts();

    captureLeadSendMessages(
      run,
      [sendMessageCall('toolu-1', { recipient: 'worker', content: 'forwarded' })],
      ports
    );
    expect(ports.pushed).toEqual([]);
    captureLeadSendMessages(run, [toolResult('toolu-1', true)], ports);

    expect(ports.pushed).toEqual([]);
    expect(ports.leadChanges).toEqual([]);
    expect(run.pendingInboxRelayCandidates).toHaveLength(1);
    expect(run.pendingLeadSendMessages.size).toBe(0);
  });

  it('persists a user message only after the runtime accepts it', () => {
    const run = createRun();
    const ports = createPorts();

    captureLeadSendMessages(
      run,
      [
        sendMessageCall('toolu-1', { recipient: 'user', content: 'rejected' }),
        sendMessageCall('toolu-2', { recipient: 'user', content: 'accepted' }),
      ],
      ports
    );
    expect(ports.sent).toEqual([]);
    captureLeadSendMessages(run, [toolResult('toolu-1', true), toolResult('toolu-2')], ports);

    expect(ports.pushed).toEqual([expect.objectContaining({ to: 'user', text: 'accepted' })]);
    expect(ports.sent).toEqual([expect.objectContaining({ to: 'user', text: 'accepted' })]);
    expect(ports.inboxChanges).toEqual(['sentMessages.json']);
  });

  it('drops calls left without a result so a late result sends nothing', async () => {
    const run = createRun();
    const crossTeamSender = vi.fn().mockResolvedValue({ messageId: 'cross-1' });
    const ports = createPorts({ crossTeamSender });
    const logger = { warn: vi.fn() };

    captureLeadSendMessages(
      run,
      [
        sendMessageCall('toolu-1', { recipient: 'beta.worker', content: 'hello' }),
        sendMessageCall('toolu-2', { recipient: 'worker', content: 'hi' }),
      ],
      ports
    );
    dropUnsettledLeadSendMessages(run, logger);
    captureLeadSendMessages(run, [toolResult('toolu-1'), toolResult('toolu-2')], ports);
    await flushPromises();

    expect(run.pendingLeadSendMessages.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      '[alpha] Dropped lead SendMessage call(s) that got no tool result: toolu-1 (cross-team), toolu-2 (member)'
    );
    expect(crossTeamSender).not.toHaveBeenCalled();
    expect(ports.pushed).toEqual([]);
  });
});
