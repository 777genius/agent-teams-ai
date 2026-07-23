import { describe, expect, it, vi } from 'vitest';

import {
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_SEND_MESSAGE,
} from '../../../src/features/team-message-delivery/contracts';
import { SendTeamMessageUseCase } from '../../../src/features/team-message-delivery/core/application/use-cases/SendTeamMessageUseCase';
import {
  registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc,
} from '../../../src/features/team-message-delivery/main';
import { createTeamMessageDeliveryIpcHandlers } from '../../../src/features/team-message-delivery/main/adapters/input/ipc/createTeamMessageDeliveryIpcHandlers';
import { normalizeSendTeamMessageCommand } from '../../../src/features/team-message-delivery/main/adapters/input/ipc/normalizeSendTeamMessageCommand';

const TEAM_MESSAGE_DELIVERY_CHANNELS = [
  TEAM_SEND_MESSAGE,
  TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS,
  TEAM_PROCESS_SEND,
  TEAM_PROCESS_ALIVE,
  TEAM_GET_ATTACHMENTS,
] as const;

function createDependencies() {
  return {
    sendMessage: {
      prevalidateDelegate: vi.fn(() => Promise.resolve(null)),
      execute: vi.fn(() =>
        Promise.resolve({
          deliveredToInbox: true,
          messageId: 'message-1',
        })
      ),
    },
    getOpenCodeRuntimeDeliveryStatus: {
      execute: vi.fn(() => Promise.resolve(null)),
    },
    sendProcessMessage: {
      execute: vi.fn(() => Promise.resolve()),
    },
    getProcessAlive: {
      execute: vi.fn(() => true),
    },
    getAttachments: {
      execute: vi.fn(() =>
        Promise.resolve([
          {
            id: 'attachment-1',
            data: 'YQ==',
            mimeType: 'text/plain' as const,
          },
        ])
      ),
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('team message delivery IPC', () => {
  it('registers and removes exactly the five owned channels', () => {
    const registeredHandlers = new Map<string, unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: unknown) => {
        registeredHandlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        registeredHandlers.delete(channel);
      }),
    };

    registerTeamMessageDeliveryIpc(ipcMain as never, createDependencies() as never);

    expect(ipcMain.handle).toHaveBeenCalledTimes(5);
    expect(ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual(
      TEAM_MESSAGE_DELIVERY_CHANNELS
    );
    expect([...registeredHandlers.keys()]).toEqual(TEAM_MESSAGE_DELIVERY_CHANNELS);

    removeTeamMessageDeliveryIpc(ipcMain as never);

    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(5);
    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
      TEAM_MESSAGE_DELIVERY_CHANNELS
    );
    expect(registeredHandlers.size).toBe(0);
  });

  it('trims and delegates OpenCode runtime delivery status identifiers', async () => {
    const dependencies = createDependencies();
    const handlers = createTeamMessageDeliveryIpcHandlers(dependencies as never);

    await expect(
      handlers.getOpenCodeRuntimeDeliveryStatus({}, '  demo-team  ', '  message-1  ')
    ).resolves.toEqual({ success: true, data: null });
    expect(dependencies.getOpenCodeRuntimeDeliveryStatus.execute).toHaveBeenCalledWith(
      'demo-team',
      'message-1'
    );
  });

  it('rejects delegate delivery to a non-lead before runtime and delivery effects', async () => {
    const isTeamAlive = vi.fn(() => true);
    const resolveRuntimeRecipientProviderId = vi.fn(() => Promise.resolve('opencode' as const));
    const liveDeliver = vi.fn();
    const inboxDeliver = vi.fn();
    const sendMessage = new SendTeamMessageUseCase({
      leadRecipient: { getLeadMemberName: vi.fn(() => Promise.resolve('team-lead')) },
      runtime: { isTeamAlive },
      messaging: { resolveRuntimeRecipientProviderId },
      liveLeadDelivery: { deliver: liveDeliver } as never,
      inboxDelivery: { deliver: inboxDeliver } as never,
    });
    const dependencies = { ...createDependencies(), sendMessage };
    const handlers = createTeamMessageDeliveryIpcHandlers(dependencies as never);

    await expect(
      handlers.sendMessage({}, 'demo-team', {
        member: 'worker',
        text: 'Delegate this',
        actionMode: 'delegate',
      })
    ).resolves.toEqual({
      success: false,
      error: 'Delegate mode is only supported when messaging the team lead',
    });
    expect(isTeamAlive).not.toHaveBeenCalled();
    expect(resolveRuntimeRecipientProviderId).not.toHaveBeenCalled();
    expect(liveDeliver).not.toHaveBeenCalled();
    expect(inboxDeliver).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'messageId must be a non-empty string'],
    ['   ', 'messageId must be a non-empty string'],
    ['../message-1', 'Invalid messageId'],
    ['message/1', 'Invalid messageId'],
    ['message\\1', 'Invalid messageId'],
    ['message..1', 'Invalid messageId'],
  ])('rejects invalid runtime status messageId %j', async (messageId, error) => {
    const dependencies = createDependencies();
    const handlers = createTeamMessageDeliveryIpcHandlers(dependencies as never);

    await expect(
      handlers.getOpenCodeRuntimeDeliveryStatus({}, 'demo-team', messageId)
    ).resolves.toEqual({ success: false, error });
    expect(dependencies.getOpenCodeRuntimeDeliveryStatus.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'rejects an empty process message without transport: %j',
    async (message) => {
      const dependencies = createDependencies();
      const handlers = createTeamMessageDeliveryIpcHandlers(dependencies as never);

      await expect(handlers.processSend({}, 'demo-team', message)).resolves.toEqual({
        success: false,
        error: 'message must be a non-empty string',
      });
      expect(dependencies.sendProcessMessage.execute).not.toHaveBeenCalled();
    }
  );

  it('validates processSend with trimmed text but transports the original message', async () => {
    const dependencies = createDependencies();
    const handlers = createTeamMessageDeliveryIpcHandlers(dependencies as never);
    const originalMessage = '  keep transport whitespace  ';

    await expect(handlers.processSend({}, '  demo-team  ', originalMessage)).resolves.toEqual({
      success: true,
      data: undefined,
    });
    expect(dependencies.sendProcessMessage.execute).toHaveBeenCalledWith(
      'demo-team',
      originalMessage
    );
  });

  it('returns a false processAlive value inside the success envelope', async () => {
    const dependencies = createDependencies();
    dependencies.getProcessAlive.execute.mockReturnValueOnce(false);
    const handlers = createTeamMessageDeliveryIpcHandlers(dependencies as never);

    await expect(handlers.processAlive({}, '  demo-team  ')).resolves.toEqual({
      success: true,
      data: false,
    });
    expect(dependencies.getProcessAlive.execute).toHaveBeenCalledWith('demo-team');
  });

  it('validates and delegates attachment lookup identifiers', async () => {
    const dependencies = createDependencies();
    const handlers = createTeamMessageDeliveryIpcHandlers(dependencies as never);

    await expect(handlers.getAttachments({}, '../demo-team', 'message-1')).resolves.toEqual({
      success: false,
      error: 'teamName contains invalid characters',
    });
    await expect(handlers.getAttachments({}, 'demo-team', '../message-1')).resolves.toEqual({
      success: false,
      error: 'Invalid messageId',
    });
    expect(dependencies.getAttachments.execute).not.toHaveBeenCalled();

    await expect(handlers.getAttachments({}, '  demo-team  ', '  message-1  ')).resolves.toEqual({
      success: true,
      data: [
        {
          id: 'attachment-1',
          data: 'YQ==',
          mimeType: 'text/plain',
        },
      ],
    });
    expect(dependencies.getAttachments.execute).toHaveBeenCalledWith('demo-team', 'message-1');
  });
});

describe('legacy attachment normalization compatibility', () => {
  it.each([
    ['a non-array value', 'legacy-attachment'],
    ['an empty array', []],
  ])('ignores %s', (_label, attachments) => {
    const result = normalizeSendTeamMessageCommand('demo-team', {
      member: 'team-lead',
      text: 'hello',
      attachments,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.error);
    expect(result.value.attachments).toBeUndefined();
  });

  it('preserves the legacy acceptance of NaN attachment size', () => {
    const result = normalizeSendTeamMessageCommand('demo-team', {
      member: 'team-lead',
      text: 'hello',
      attachments: [
        {
          id: 'attachment-1',
          filename: 'note.txt',
          data: 'YQ==',
          mimeType: 'text/plain',
          size: Number.NaN,
        },
      ],
    });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.error);
    expect(result.value.attachments).toHaveLength(1);
    expect(result.value.attachments?.[0]?.size).toBeNaN();
  });
});
