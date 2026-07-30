import { describe, expect, it, vi } from 'vitest';

import {
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_RUNTIME_DELIVERY_STATUS,
  TEAM_SEND_MESSAGE,
} from '../../../src/features/team-message-delivery/contracts';
import { SendTeamMessageUseCase } from '../../../src/features/team-message-delivery/core/application/use-cases/SendTeamMessageUseCase';
import { createTeamMessageDeliveryIpcHandlers } from '../../../src/features/team-message-delivery/main/adapters/input/ipc/createTeamMessageDeliveryIpcHandlers';
import { normalizeSendTeamMessageCommand } from '../../../src/features/team-message-delivery/main/adapters/input/ipc/normalizeSendTeamMessageCommand';
import {
  registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc,
} from '../../../src/features/team-message-delivery/main/adapters/input/ipc/registerTeamMessageDeliveryIpc';

const TEAM_MESSAGE_DELIVERY_CHANNELS = [
  TEAM_SEND_MESSAGE,
  TEAM_GET_RUNTIME_DELIVERY_STATUS,
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
    getRuntimeDeliveryStatus: {
      execute: vi.fn(() => Promise.resolve(null)),
    },
    presentRuntimeDeliveryStatus: vi.fn((status) => status),
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
  it('registers and removes exactly the three feature-owned channels', () => {
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

    expect(ipcMain.handle).toHaveBeenCalledTimes(3);
    expect(ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual(
      TEAM_MESSAGE_DELIVERY_CHANNELS
    );
    expect([...registeredHandlers.keys()]).toEqual(TEAM_MESSAGE_DELIVERY_CHANNELS);

    removeTeamMessageDeliveryIpc(ipcMain as never);

    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3);
    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
      TEAM_MESSAGE_DELIVERY_CHANNELS
    );
    expect(registeredHandlers.size).toBe(0);
  });

  it('keeps the legacy handler name while delegating neutral runtime delivery identifiers', async () => {
    const dependencies = createDependencies();
    const handlers = createTeamMessageDeliveryIpcHandlers(dependencies as never);

    await expect(
      handlers.getOpenCodeRuntimeDeliveryStatus({}, '  demo-team  ', '  message-1  ')
    ).resolves.toEqual({ success: true, data: null });
    expect(dependencies.getRuntimeDeliveryStatus.execute).toHaveBeenCalledWith(
      'demo-team',
      'message-1'
    );
  });

  it('rejects delegate delivery to a non-lead before runtime and delivery effects', async () => {
    const isTeamAlive = vi.fn(() => true);
    const resolveRecipientRoute = vi.fn(() =>
      Promise.resolve({ providerId: 'opencode' as const, requiresRuntimeDelivery: true })
    );
    const liveDeliver = vi.fn();
    const inboxDeliver = vi.fn();
    const sendMessage = new SendTeamMessageUseCase({
      leadRecipient: { getLeadMemberName: vi.fn(() => Promise.resolve('team-lead')) },
      runtime: { isTeamAlive },
      messaging: { resolveRecipientRoute },
      compatibility: { attachmentSupportError: () => 'attachments unsupported' },
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
    expect(resolveRecipientRoute).not.toHaveBeenCalled();
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
    expect(dependencies.getRuntimeDeliveryStatus.execute).not.toHaveBeenCalled();
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

describe('attachment normalization compatibility', () => {
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

  it('rejects a non-finite attachment size before it can bypass the aggregate limit', () => {
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

    expect(result).toEqual({
      valid: false,
      error: 'Attachment must have a positive size',
    });
  });
});
