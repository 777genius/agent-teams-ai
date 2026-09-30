import { LegacyOpenCodeMessageTransportAdapter } from '@features/team-message-delivery/main/adapters/output/LegacyOpenCodeMessageTransportAdapter';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeDeliveryStatus } from '@features/team-message-delivery';
import type { LegacyOpenCodeMessageTransportHost } from '@features/team-message-delivery/main/adapters/output/LegacyOpenCodeMessageTransportAdapter';
import type { OpenCodeRuntimeDeliveryStatus } from '@shared/types';

const legacyStatus: OpenCodeRuntimeDeliveryStatus = {
  providerId: 'opencode',
  attempted: true,
  delivered: true,
  accepted: true,
  messageId: 'message-1',
};

function createHost(): LegacyOpenCodeMessageTransportHost {
  return {
    sendMessageToTeam: vi.fn(() => Promise.resolve()),
    resolveRuntimeRecipientProviderId: vi.fn(() => Promise.resolve('opencode' as const)),
    relayOpenCodeMemberInboxMessages: vi.fn(() =>
      Promise.resolve({ relayed: 1, attempted: 1, delivered: 1, failed: 0 })
    ),
    relayLeadInboxMessages: vi.fn(() => Promise.resolve(1)),
    getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(legacyStatus)),
    pushLiveLeadProcessMessage: vi.fn(),
  };
}

describe('LegacyOpenCodeMessageTransportAdapter', () => {
  it('converts the legacy provider resolver into the neutral delivery route', async () => {
    const host = createHost();
    const adapter = new LegacyOpenCodeMessageTransportAdapter(host);

    await expect(adapter.resolveRecipientRoute('team-a', 'worker')).resolves.toEqual({
      providerId: 'opencode',
      requiresRuntimeDelivery: true,
    });
    expect(host.resolveRuntimeRecipientProviderId).toHaveBeenCalledWith('team-a', 'worker');
  });

  it('preserves legacy status identity through both adapter directions', async () => {
    const adapter = new LegacyOpenCodeMessageTransportAdapter(createHost());

    await expect(adapter.getRuntimeDeliveryStatus('team-a', 'message-1')).resolves.toBe(
      legacyStatus
    );
    expect(adapter.toLegacyRuntimeDeliveryStatus(legacyStatus)).toBe(legacyStatus);
  });

  it('keeps provider-specific reply instructions and attachment text at the legacy boundary', () => {
    const adapter = new LegacyOpenCodeMessageTransportAdapter(createHost());
    const codexRoute = {
      providerId: 'codex' as const,
      isLeadRecipient: false,
      replyRecipient: 'user',
    };

    expect(adapter.requiresGeneratedMessageId(codexRoute)).toBe(true);
    expect(
      adapter.buildRecipientDeliveryText({
        ...codexRoute,
        actionModeBlock: '',
        baseText: 'Please review this',
        memberName: 'worker',
        messageId: 'message-1',
        teamName: 'team-a',
      })
    ).toContain('agent-teams_message_send');
    expect(
      adapter.requiresGeneratedMessageId({
        providerId: 'anthropic',
        isLeadRecipient: false,
        replyRecipient: 'user',
      })
    ).toBe(false);
    expect(adapter.attachmentSupportError('runtime-recipient-offline')).toBe(
      'Attachments for OpenCode teammates require the team to be online'
    );
    expect(adapter.attachmentSupportError('unsupported-recipient')).toBe(
      'Attachments are supported for the online team lead and online OpenCode teammates only'
    );
  });

  it('owns the frozen pending and missing-delivery reason values', () => {
    const adapter = new LegacyOpenCodeMessageTransportAdapter(createHost());

    expect(adapter.buildTimeoutRelayResult()).toEqual({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 1,
      lastDelivery: {
        delivered: true,
        accepted: false,
        responsePending: true,
        acceptanceUnknown: true,
        responseState: 'not_observed',
        reason: 'opencode_runtime_delivery_ui_timeout_pending',
        diagnostics: ['opencode_runtime_delivery_ui_timeout_pending'],
      },
    });
    expect(
      adapter.buildMissingDelivery({
        relayed: 0,
        attempted: 1,
        delivered: 0,
        failed: 1,
      })
    ).toEqual({
      delivered: false,
      reason: 'opencode_message_delivery_not_attempted',
      diagnostics: undefined,
    });
  });

  it('owns legacy delivery interpretation and warning presentation', () => {
    const adapter = new LegacyOpenCodeMessageTransportAdapter(createHost());

    expect(
      adapter.shouldLookupStatusAfterRelay({
        relayed: 1,
        attempted: 1,
        delivered: 1,
        failed: 0,
        lastDelivery: { delivered: true },
      })
    ).toBe(true);
    expect(adapter.statusToRelayResult(legacyStatus)).toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
      lastDelivery: { delivered: true, accepted: true },
    });
    expect(
      adapter.formatWarning({
        kind: 'delivery-failure',
        memberName: 'worker',
        delivery: { delivered: false, reason: 'recipient_is_not_opencode' },
      })
    ).toBeNull();
    expect(
      adapter.formatWarning({
        kind: 'late-rejection',
        memberName: 'worker',
        error: { message: 'late failure' },
      })
    ).toBe(
      'OpenCode runtime delivery after sendMessage rejected after UI timeout for teammate "worker": late failure'
    );
  });

  it('rejects a non-OpenCode status only at the legacy adapter boundary', () => {
    const adapter = new LegacyOpenCodeMessageTransportAdapter(createHost());
    const status: RuntimeDeliveryStatus = {
      providerId: 'codex',
      attempted: true,
      delivered: false,
      messageId: 'message-2',
    };

    expect(() => adapter.toLegacyRuntimeDeliveryStatus(status)).toThrow(
      'Expected OpenCode runtime delivery status, received codex'
    );
    expect(() =>
      adapter.toLegacySendMessageResult({
        deliveredToInbox: true,
        messageId: 'message-2',
        runtimeDelivery: { providerId: 'codex', attempted: true, delivered: false },
      })
    ).toThrow('Expected OpenCode runtime delivery status, received codex');
  });
});
