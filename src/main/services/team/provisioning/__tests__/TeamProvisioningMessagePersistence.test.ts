import { describe, expect, it, vi } from 'vitest';

import {
  persistTeamProvisioningInboxMessage,
  persistTeamProvisioningSentMessage,
  type TeamProvisioningInboxMessagePersistencePorts,
} from '../TeamProvisioningMessagePersistence';

import type { InboxMessage } from '@shared/types';

function createMessage(): InboxMessage {
  return {
    from: 'lead',
    to: 'worker',
    text: 'Please review this',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    taskRefs: [{ taskId: 'task-1', displayId: 'T-1', teamName: 'alpha' }],
    actionMode: 'ask',
    commentId: 'comment-1',
    summary: 'Review request',
    color: '#123456',
    messageId: 'message-1',
    relayOfMessageId: 'source-1',
    source: 'lead_session',
    attachments: [
      {
        id: 'attachment-1',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        size: 12,
        filePath: '/home/tester/notes.txt',
      },
    ],
    leadSessionId: 'session-1',
    conversationId: 'conversation-1',
    replyToConversationId: 'conversation-0',
    toolSummary: '1 tool (Read)',
    toolCalls: [{ name: 'Read', preview: 'notes.txt', toolUseId: 'tool-1' }],
    messageKind: 'slash_command',
    workSyncIntent: 'review_pickup',
    workSyncIntentKey: 'review-1',
    workSyncReviewRequestEventIds: ['event-1'],
    workSyncPayloadHash: 'payload-hash-1',
    slashCommand: { name: 'status', command: '/status', args: 'now' },
    commandOutput: { stream: 'stdout', commandLabel: '/status' },
  };
}

function createExpectedSentPayload() {
  return {
    from: 'lead',
    to: 'worker',
    text: 'Please review this',
    timestamp: '2026-01-01T00:00:00.000Z',
    summary: 'Review request',
    messageId: 'message-1',
    relayOfMessageId: 'source-1',
    source: 'lead_session',
    leadSessionId: 'session-1',
    conversationId: 'conversation-1',
    replyToConversationId: 'conversation-0',
    taskRefs: [{ taskId: 'task-1', displayId: 'T-1', teamName: 'alpha' }],
    attachments: [
      {
        id: 'attachment-1',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        size: 12,
        filePath: '/home/tester/notes.txt',
      },
    ],
    color: '#123456',
    toolSummary: '1 tool (Read)',
    toolCalls: [{ name: 'Read', preview: 'notes.txt', toolUseId: 'tool-1' }],
    messageKind: 'slash_command',
    workSyncIntent: 'review_pickup',
    workSyncIntentKey: 'review-1',
    workSyncReviewRequestEventIds: ['event-1'],
    slashCommand: { name: 'status', command: '/status', args: 'now' },
    commandOutput: { stream: 'stdout', commandLabel: '/status' },
  };
}

function createPorts(
  overrides: Partial<TeamProvisioningInboxMessagePersistencePorts> = {}
): TeamProvisioningInboxMessagePersistencePorts & {
  appendSentMessage: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  advisoryRefresh: ReturnType<typeof vi.fn>;
} {
  const appendSentMessage = vi.fn();
  const sendMessage = vi.fn();
  const advisoryRefresh = vi.fn();
  return {
    appendSentMessage,
    sendMessage,
    advisoryRefresh,
    createController: vi.fn(() => ({
      messages: {
        appendSentMessage,
        sendMessage,
      },
    })),
    getClaudeBasePath: vi.fn(() => '/home/tester/.claude'),
    logger: {
      warn: vi.fn(),
    },
    emitRuntimeDeliveryReplyAdvisoryRefresh: advisoryRefresh,
    ...overrides,
  };
}

describe('TeamProvisioningMessagePersistence', () => {
  it('persists sent messages with the existing controller field mapping', () => {
    const ports = createPorts();
    const message = createMessage();

    persistTeamProvisioningSentMessage('alpha', message, ports);

    expect(ports.createController).toHaveBeenCalledWith({
      teamName: 'alpha',
      claudeDir: '/home/tester/.claude',
    });
    expect(ports.appendSentMessage).toHaveBeenCalledWith(createExpectedSentPayload());
    expect(ports.sendMessage).not.toHaveBeenCalled();
    expect(ports.advisoryRefresh).not.toHaveBeenCalled();
    expect(ports.logger.warn).not.toHaveBeenCalled();
  });

  it('persists inbox messages with the existing controller field mapping and advisory refresh', () => {
    const ports = createPorts();
    const message = createMessage();
    const expectedPayload = Object.fromEntries(
      Object.entries(createExpectedSentPayload()).filter(([key]) => key !== 'to')
    );

    persistTeamProvisioningInboxMessage('alpha', 'worker', message, ports);

    expect(ports.sendMessage).toHaveBeenCalledWith({
      member: 'worker',
      ...expectedPayload,
    });
    expect(ports.appendSentMessage).not.toHaveBeenCalled();
    expect(ports.advisoryRefresh).toHaveBeenCalledWith('alpha', message);
    expect(ports.logger.warn).not.toHaveBeenCalled();
  });

  it('preserves sent-message warning behavior when controller persistence fails', () => {
    const ports = createPorts({
      createController: vi.fn(() => {
        throw new Error('disk full');
      }),
    });

    persistTeamProvisioningSentMessage('alpha', createMessage(), ports);

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[alpha] sent-message persist failed: Error: disk full'
    );
  });

  it('preserves inbox-message warning behavior and skips advisory refresh on failure', () => {
    const ports = createPorts();
    ports.sendMessage.mockImplementation(() => {
      throw new Error('write denied');
    });

    persistTeamProvisioningInboxMessage('alpha', 'worker', createMessage(), ports);

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[alpha] inbox-message persist for worker failed: Error: write denied'
    );
    expect(ports.advisoryRefresh).not.toHaveBeenCalled();
  });
});
