import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrossTeamService } from '../CrossTeamService';

import type { TeamCrossTeamMessagingApi } from '../contracts/TeamProvisioningApis';
import type { TeamConfigReader } from '../TeamConfigReader';
import type { TeamDataService } from '../TeamDataService';
import type { TeamInboxWriter } from '../TeamInboxWriter';
import type { CrossTeamSendRequest, InboxMessage, TeamConfig } from '@shared/types';

const controllerMocks = vi.hoisted(() => ({
  appendSentMessage: vi.fn(),
  lookupMessage: vi.fn(() => {
    throw new Error('not found');
  }),
}));

vi.mock('agent-teams-controller', () => ({
  createController: vi.fn(() => ({
    messages: {
      appendSentMessage: controllerMocks.appendSentMessage,
      lookupMessage: controllerMocks.lookupMessage,
    },
  })),
  protocols: {
    buildActionModeProtocolText: vi.fn(() => ''),
  },
}));

function teamConfig(name: string): TeamConfig {
  return {
    name,
    members: [{ name: 'team-lead', agentType: 'team-lead' }],
  };
}

function createService() {
  const sentToInbox: Array<{ teamName: string; message: InboxMessage }> = [];
  const configs = new Map<string, TeamConfig>([
    ['source-team', teamConfig('Source Team')],
    ['target-team', teamConfig('Target Team')],
  ]);
  const configReader = {
    getConfig: vi.fn(async (teamName: string) => configs.get(teamName) ?? null),
  } as unknown as TeamConfigReader;
  const dataService = {
    getLeadMemberName: vi.fn(async () => 'team-lead'),
  } as unknown as TeamDataService;
  const inboxWriter = {
    sendMessage: vi.fn(async (teamName: string, message: InboxMessage) => {
      sentToInbox.push({ teamName, message });
    }),
  } as unknown as TeamInboxWriter;
  const messaging: TeamCrossTeamMessagingApi = {
    resolveCrossTeamReplyMetadata: vi.fn(() => null),
    registerPendingCrossTeamReplyExpectation: vi.fn(),
    clearPendingCrossTeamReplyExpectation: vi.fn(),
    isTeamAlive: vi.fn(() => false),
    relayInboxFileToLiveRecipient: vi.fn<
      TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']
    >(async () => ({
      kind: 'opencode_member',
      relayed: 1,
    })),
    relayLeadInboxMessages: vi.fn(async () => 0),
  };

  return {
    service: new CrossTeamService(configReader, dataService, inboxWriter, messaging),
    inboxWriter,
    messaging,
    sentToInbox,
  };
}

function runtimeRequest(overrides: Partial<CrossTeamSendRequest> = {}): CrossTeamSendRequest {
  return {
    fromTeam: 'source-team',
    fromMember: 'team-lead',
    toTeam: 'target-team',
    toMember: 'team-lead',
    text: 'Ship the same payload',
    summary: 'Runtime delivery',
    taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'source-team' }],
    timestamp: new Date().toISOString(),
    messageId: 'runtime-message-1',
    conversationId: 'runtime-idempotency-1',
    requireRuntimeDelivery: true,
    ...overrides,
  };
}

describe('CrossTeamService runtime delivery dedupe', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-team-service-'));
    setClaudeBasePathOverride(tempRoot);
    controllerMocks.appendSentMessage.mockClear();
    controllerMocks.lookupMessage.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setClaudeBasePathOverride(null);
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps runtime retries idempotent when the trimmed caller message id matches', async () => {
    const { service, inboxWriter, messaging, sentToInbox } = createService();
    const request = runtimeRequest();
    const retry = runtimeRequest({
      messageId: '\truntime-message-1\n',
      conversationId: 'runtime-idempotency-2',
      text: 'Retry payload changed after the caller message id was already recorded',
      summary: 'Retry summary changed',
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'source-team' }],
    });

    await expect(service.send(request)).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
    });
    await expect(service.send(retry)).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
      deduplicated: true,
    });

    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentToInbox.map((entry) => entry.message.messageId)).toEqual(['runtime-message-1']);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledTimes(2);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenNthCalledWith(
      2,
      'target-team',
      'team-lead',
      { onlyMessageId: 'runtime-message-1' }
    );
  });

  it('dedupes runtime retries without caller message ids by conversation identity', async () => {
    const { service, sentToInbox } = createService();
    const request = runtimeRequest({
      messageId: undefined,
      conversationId: 'runtime-idempotency-1',
    });
    const retry = runtimeRequest({
      messageId: undefined,
      conversationId: '\truntime-idempotency-1\n',
      text: 'Retry payload changed after the conversation was already recorded',
      summary: 'Retry summary changed',
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'source-team' }],
    });

    const first = await service.send(request);
    await expect(service.send(retry)).resolves.toMatchObject({
      messageId: first.messageId,
      deliveredToInbox: true,
      deduplicated: true,
    });

    expect(first.messageId).not.toBe('');
    expect(sentToInbox.map((entry) => entry.message.messageId)).toEqual([first.messageId]);
  });

  it('does not accept unrelated native-lead relay work as runtime proof', async () => {
    const { service, messaging } = createService();
    vi.mocked(messaging.relayInboxFileToLiveRecipient).mockResolvedValue({
      kind: 'native_lead',
      relayed: 0,
      diagnostics: ['unrelated native lead relay completed for another message'],
    });

    await expect(service.send(runtimeRequest())).rejects.toThrow(
      'unrelated native lead relay completed for another message'
    );
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledWith(
      'target-team',
      'team-lead',
      { onlyMessageId: 'runtime-message-1' }
    );
    expect(controllerMocks.appendSentMessage).not.toHaveBeenCalled();
  });

  it('keeps body-based dedupe for normal callers without stable ids', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-09T00:00:00.000Z') });
    const { service, inboxWriter, messaging, sentToInbox } = createService();
    const request: CrossTeamSendRequest = {
      fromTeam: 'source-team',
      fromMember: 'team-lead',
      toTeam: 'target-team',
      toMember: 'team-lead',
      text: 'Ship the same payload',
      summary: 'Runtime delivery',
      taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'source-team' }],
      timestamp: '2026-07-09T00:00:00.000Z',
    };

    const first = await service.send(request);
    await expect(service.send(request)).resolves.toMatchObject({
      deliveredToInbox: true,
      deduplicated: true,
      messageId: first.messageId,
    });

    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentToInbox).toHaveLength(1);
    expect(messaging.relayInboxFileToLiveRecipient).not.toHaveBeenCalled();
  });

  it('does not runtime-dedupe normal follow-ups in the same conversation', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-09T00:00:00.000Z') });
    const { service, inboxWriter, messaging, sentToInbox } = createService();
    const request: CrossTeamSendRequest = {
      fromTeam: 'source-team',
      fromMember: 'team-lead',
      toTeam: 'target-team',
      toMember: 'team-lead',
      text: 'First follow-up',
      summary: 'Conversation follow-up',
      conversationId: 'shared-conversation',
      timestamp: '2026-07-09T00:00:00.000Z',
    };

    const first = await service.send(request);
    vi.advanceTimersByTime(3_001);
    const second = await service.send({
      ...request,
      text: 'Second follow-up',
      timestamp: '2026-07-09T00:00:01.000Z',
    });

    expect(first).toMatchObject({ deliveredToInbox: true });
    expect(second).toMatchObject({ deliveredToInbox: true });
    expect(first.deduplicated).toBeUndefined();
    expect(second.deduplicated).toBeUndefined();
    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(2);
    expect(sentToInbox.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining('First follow-up'),
      expect.stringContaining('Second follow-up'),
    ]);
    expect(messaging.relayInboxFileToLiveRecipient).not.toHaveBeenCalled();
  });

  it('delivers distinct caller message ids in the same conversation', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-09T00:00:00.000Z') });
    const { service, inboxWriter, messaging, sentToInbox } = createService();

    await expect(
      service.send(
        runtimeRequest({
          messageId: 'runtime-message-1',
          conversationId: 'runtime-idempotency-1',
        })
      )
    ).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
    });
    vi.advanceTimersByTime(3_001);
    await expect(
      service.send(
        runtimeRequest({
          messageId: 'runtime-message-2',
          conversationId: 'runtime-idempotency-1',
        })
      )
    ).resolves.toMatchObject({
      messageId: 'runtime-message-2',
      deliveredToInbox: true,
    });

    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(2);
    expect(sentToInbox.map((entry) => entry.message.messageId)).toEqual([
      'runtime-message-1',
      'runtime-message-2',
    ]);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledTimes(2);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenNthCalledWith(
      2,
      'target-team',
      'team-lead',
      { onlyMessageId: 'runtime-message-2' }
    );
  });
});
