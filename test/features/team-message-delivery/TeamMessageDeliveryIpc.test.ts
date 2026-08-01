import { describe, expect, it, vi } from 'vitest';

import {
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_RUNTIME_DELIVERY_STATUS,
  TEAM_SEND_MESSAGE,
} from '../../../src/features/team-message-delivery/contracts';
import { SendTeamMessageUseCase } from '../../../src/features/team-message-delivery/core/application/use-cases/SendTeamMessageUseCase';
import { createDesktopTeamMessageDeliveryFeature } from '../../../src/features/team-message-delivery/main';
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

  it('skips video recipient reads for non-video image, text, and PDF sends', async () => {
    const getLeadMemberName = vi.fn(() => Promise.reject(new Error('normal resolution failure')));
    const getTeamData = vi.fn();
    const resolveRuntimeRecipientProviderId = vi.fn();
    const feature = createDesktopTeamMessageDeliveryFeature({
      repository: { getLeadMemberName, getTeamData },
      messaging: { resolveRuntimeRecipientProviderId },
      runtime: { isTeamAlive: vi.fn(() => true) },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      attachments: {},
      roster: { getMembers: vi.fn(() => Promise.resolve([])) },
      actionModeInstructions: {},
      runtimeDeliveryImpact: {},
    } as never);
    const handlers = createTeamMessageDeliveryIpcHandlers(feature);

    for (const attachment of [
      { filename: 'image.png', mimeType: 'image/png' },
      { filename: 'notes.txt', mimeType: 'text/plain' },
      { filename: 'document.pdf', mimeType: 'application/pdf' },
    ]) {
      await expect(
        handlers.sendMessage({}, 'demo-team', {
          member: 'worker',
          text: 'Review this attachment',
          attachments: [
            {
              id: attachment.filename,
              ...attachment,
              size: 1,
              data: 'YQ==',
            },
          ],
        })
      ).resolves.toEqual({ success: false, error: 'normal resolution failure' });
    }

    expect(getLeadMemberName).toHaveBeenCalledTimes(3);
    expect(resolveRuntimeRecipientProviderId).not.toHaveBeenCalled();
    expect(getTeamData).not.toHaveBeenCalled();
  });

  it('keeps model-specific video rejection inside the extracted feature composition', async () => {
    const getTeamData = vi.fn(() =>
      Promise.resolve({
        members: [
          {
            name: 'worker',
            providerId: 'opencode',
            model: 'moonshotai/kimi-k2.6',
          },
        ],
      })
    );
    const resolveRuntimeRecipientProviderId = vi.fn(() => Promise.resolve('opencode'));
    const feature = createDesktopTeamMessageDeliveryFeature({
      repository: {
        getLeadMemberName: vi.fn(() => Promise.resolve('team-lead')),
        getTeamData,
      },
      messaging: {
        resolveRuntimeRecipientProviderId,
      },
      runtime: { isTeamAlive: vi.fn(() => true) },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      attachments: {},
      roster: { getMembers: vi.fn(() => Promise.resolve([])) },
      actionModeInstructions: {},
      runtimeDeliveryImpact: {},
    } as never);
    const handlers = createTeamMessageDeliveryIpcHandlers(feature);

    await expect(
      handlers.sendMessage({}, 'demo-team', {
        member: 'worker',
        text: 'Review this clip',
        attachments: [
          {
            id: 'video-1',
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            size: 4,
            data: 'dGVzdA==',
          },
        ],
      })
    ).resolves.toEqual({
      success: false,
      error: 'This provider path does not support video attachments through this delivery path.',
    });
    expect(resolveRuntimeRecipientProviderId).toHaveBeenCalledWith('demo-team', 'worker');
    expect(getTeamData).toHaveBeenCalledWith('demo-team');
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
