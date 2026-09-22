import { describe, expect, it, vi } from 'vitest';

import {
  captureLeadSendMessages,
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
    ...overrides,
  };
}

function createPorts(
  overrides: Partial<TeamProvisioningLeadSendMessageCapturePorts> = {}
): TeamProvisioningLeadSendMessageCapturePorts & {
  pushed: InboxMessage[];
  sent: InboxMessage[];
  inbox: Array<{ recipient: string; message: InboxMessage }>;
  inboxChanges: string[];
  leadChanges: string[];
} {
  const pushed: InboxMessage[] = [];
  const sent: InboxMessage[] = [];
  const inbox: Array<{ recipient: string; message: InboxMessage }> = [];
  const inboxChanges: string[] = [];
  const leadChanges: string[] = [];
  return {
    pushed,
    sent,
    inbox,
    inboxChanges,
    leadChanges,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    nowMs: () => 123,
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    crossTeamSender: null,
    resolveCrossTeamReplyMetadata: () => null,
    getTrackedRunId: () => 'run-1',
    pushLiveLeadProcessMessage: (_teamName, message) => pushed.push(message),
    persistSentMessage: (_teamName, message) => sent.push(message),
    persistInboxMessage: (_teamName, recipient, message) => inbox.push({ recipient, message }),
    emitLeadMessageChange: (_teamName, _runId, detail) => leadChanges.push(detail),
    emitInboxChange: (_teamName, detail) => inboxChanges.push(detail),
    ...overrides,
  };
}

describe('lead SendMessage capture helpers', () => {
  it('captures native SendMessage to the user and persists sent messages', () => {
    const run = createRun();
    const ports = createPorts();

    captureLeadSendMessages(
      run,
      [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: { recipient: 'user', content: 'Hello user', summary: 'Hi' },
        },
      ],
      ports
    );

    expect(ports.pushed).toEqual([
      expect.objectContaining({
        from: 'lead',
        to: 'user',
        text: 'Hello user',
        messageId: 'lead-sendmsg-run-1-123',
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
      [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: { recipient: 'user', content: 'wrong recipient' },
        },
      ],
      ports
    );

    expect(ports.pushed).toEqual([]);
    expect(ports.sent).toEqual([]);
    expect(ports.logger.debug).toHaveBeenCalledWith(
      '[alpha] Suppressed SendMessage→user during member_inbox_relay to "worker"'
    );
  });

  it('captures native SendMessage to a teammate inbox with relay provenance', () => {
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
      [
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: { recipient: 'worker', content: 'forwarded' },
        },
      ],
      ports
    );

    expect(ports.inbox).toEqual([
      {
        recipient: 'worker',
        message: expect.objectContaining({
          to: 'worker',
          relayOfMessageId: 'source-1',
          read: true,
        }),
      },
    ]);
    expect(ports.inboxChanges).toEqual(['inboxes/worker.json']);
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
        {
          type: 'tool_use',
          name: 'SendMessage',
          input: { recipient: 'beta.worker', content: 'hello', summary: 'hello' },
        },
      ],
      ports
    );
    await Promise.resolve();

    expect(crossTeamSender).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTeam: 'alpha',
        fromMember: 'lead',
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
});
