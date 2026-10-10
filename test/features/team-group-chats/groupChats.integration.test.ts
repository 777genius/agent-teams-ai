import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { configureDesktopMcpEnvironment } from '@features/external-agent-connection/main/desktopMcpEnvironment';
import { DEFAULT_TEAM_GROUP_CHAT_ID, GROUP_CHAT_CHANNELS } from '@features/team-group-chats/contracts';
import { registerTeamGroupChatsIpc } from '@features/team-group-chats/main';
import { createGroupChatRuntimePorts, createOpenCodeGroupChatRunGetter, registerTeamGroupChatsHttp } from '@features/team-group-chats/main';
import { createOpenCodeBridgeHandshakeIdentityHash, type OpenCodeBridgeHandshake } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import { createOpenCodeBridgeClientIdentity } from '@main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { buildGroupPlainTextVisibleReplyMessageId, buildPlainTextVisibleReplyMessageId } from '@main/services/team/opencode/delivery/OpenCodeGroupVisibleReply';
import { createOpenCodePromptDeliveryLedgerStore } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { OpenCodeVisibleReplyProofService } from '@main/services/team/opencode/delivery/OpenCodeVisibleReplyProofService';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readFile, rm,writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpStdIoClient } from '../../../mcp-server/test/McpStdIoClient';
import { createTeamGroupChatsFeature } from '../../../src/features/team-group-chats/main/composition/createTeamGroupChatsFeature';

import type {
  TeamGroupChatsFeature,
  TeamGroupChatsPorts,
} from '../../../src/features/team-group-chats/main/composition/createTeamGroupChatsFeature';
import type { InboxMessage } from '../../../src/shared/types/team';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('@main/utils/pathDecoder', async (original) => ({
  ...(await original<object>()),
  getTeamsBasePath: () => state.root,
}));

describe('group chat main authority and durable identity', () => {
  let feature: TeamGroupChatsFeature;
  let roster: string[];
  let deliveries: InboxMessage[];
  let available: boolean;
  let unavailableMembers: Set<string>;
  let runPrefix: string;
  let deliver: TeamGroupChatsPorts['deliver'];
  const create = () =>
    feature.create({
      teamName: 'sandbox',
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Release',
      selectedMemberNames: ['lead', 'alice'],
      excludedMemberNames: ['bob'],
      autoIncludeNewMembers: true,
    });
  const send = () =>
    feature.send({
      teamName: 'sandbox',
      groupChatId: '10000000-0000-4000-8000-000000000001',
      messageId: '20000000-0000-4000-8000-000000000001',
      text: 'Hello team',
    });

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'group-chats-proof-'));
    await mkdir(join(state.root, 'sandbox', 'inboxes'), { recursive: true });
    roster = ['lead', 'alice', 'bob'];
    deliveries = [];
    available = true;
    unavailableMembers = new Set();
    runPrefix = 'run';
    deliver = async (_team, message) => {
      deliveries.push(message);
      return 'accepted';
    };
    feature = createTeamGroupChatsFeature({
      roster: async () => roster,
      getRun: async (_team, name) =>
        available && !unavailableMembers.has(name)
          ? { runKey: `${runPrefix}:${name}`, protocolVersion: 1, provider: 'native' } : null,
      configurationOperation: (_team, operation) => operation(),
      deliver: (...args) => deliver(...args),
    });
  });
  afterEach(async () => {
    await rm(state.root, { recursive: true, force: true });
  });

  it('keeps initial exclusions and adds future members even in archive; create retry returns first record', async () => {
    await create();
    await feature.setArchived({ teamName: 'sandbox', groupChatId: '10000000-0000-4000-8000-000000000001', archived: true });
    roster.push('david');
    const [group] = await feature.list({ teamName: 'sandbox' });
    expect(group.memberNames).toEqual(['lead', 'alice', 'david']);
    expect(group.reason).toBe('archived');
    expect(
      (
        await feature.create({
          teamName: 'sandbox',
          id: '10000000-0000-4000-8000-000000000001',
          name: 'Changed',
          selectedMemberNames: ['lead', 'alice'],
          excludedMemberNames: [],
          autoIncludeNewMembers: false,
        })
      ).name
    ).toBe('Release');
    await expect(send()).rejects.toMatchObject({ code: 'archived' });
    expect(deliveries).toHaveLength(0);
    await feature.setArchived({ teamName: 'sandbox', groupChatId: '10000000-0000-4000-8000-000000000001', archived: false });
    available = false;
    await expect(send()).rejects.toMatchObject({ code: 'recipient-unavailable' });
  });

  it('allows concurrent catalog reads while list/create/restore runtime projections are pending', async () => {
    await create();
    for (const operation of ['list', 'create', 'create-retry', 'restore']) {
      if (operation === 'restore')
        await feature.setArchived({
          teamName: 'sandbox',
          groupChatId: '10000000-0000-4000-8000-000000000001',
          archived: true,
        });
      let release!: () => void;
      let entered!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const projecting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const slowFeature = createTeamGroupChatsFeature({
        roster: () => Promise.resolve(roster),
        getRun: async (_team, name) => {
          entered();
          await pending;
          return { runKey: 'run:' + name, protocolVersion: 1, provider: 'native' };
        },
        configurationOperation: (_team, run) => run(),
        deliver: (...args) => deliver(...args),
      });
      let slowResult: Promise<unknown>;
      if (operation === 'list') {
        slowResult = slowFeature.list({ teamName: 'sandbox' });
      } else if (operation === 'restore') {
        slowResult = slowFeature.setArchived({
          teamName: 'sandbox',
          groupChatId: '10000000-0000-4000-8000-000000000001',
          archived: false,
        });
      } else {
        slowResult = slowFeature.create({
          teamName: 'sandbox',
          id: operation === 'create' ? randomUUID() : '10000000-0000-4000-8000-000000000001',
          name: 'Another',
          selectedMemberNames: ['lead', 'alice'],
          excludedMemberNames: [],
          autoIncludeNewMembers: false,
        });
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await projecting;
        const concurrent = await Promise.race([
          feature.list({ teamName: 'sandbox' }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Catalog blocked by ' + operation + ' projection')),
              1000
            );
          }),
        ]);
        expect(
          concurrent.find((group) => group.id === '10000000-0000-4000-8000-000000000001')
        ).toMatchObject({
          name: 'Release',
          memberNames: ['lead', 'alice'],
          canSend: true,
        });
      } finally {
        clearTimeout(timeout);
        release();
        await slowResult;
      }
    }
  });

  it('saves one canonical row, settles every recipient, and never re-fanouts a retry or ID conflict', async () => {
    await create();
    deliver = async (_team, message) => {
      deliveries.push(message);
      if (message.to === 'lead') throw new Error('Lost transport proof');
      return 'accepted';
    };
    const saved = await send();
    expect(saved.saved).toBe(true);
    expect(saved.statusPersisted).toBe(true);
    expect(saved.deliverySummary?.recipients.map((row) => row.status)).toEqual([
      'unknown',
      'accepted',
    ]);
    expect(new Set(deliveries.map((row) => row.messageId)).size).toBe(2);
    await feature.setArchived({ teamName: 'sandbox', groupChatId: '10000000-0000-4000-8000-000000000001', archived: true });
    expect(await send()).toEqual(saved);
    await expect(
      feature.send({
        teamName: 'sandbox',
        groupChatId: '10000000-0000-4000-8000-000000000001',
        messageId: '20000000-0000-4000-8000-000000000001',
        text: 'Different',
      })
    ).rejects.toMatchObject({ code: 'conflicting-id' });
    expect(deliveries).toHaveLength(2);
    const rows = JSON.parse(
      await readFile(join(state.root, 'sandbox', 'inboxes', 'user.json'), 'utf8')
    ) as InboxMessage[];
    expect(rows).toHaveLength(1);
    expect(rows[0].groupMessageId).toBe(rows[0].messageId);
  });

  it('delivers a human target only, freezes its identity across roster/run changes, and keeps All distinct', async () => {
    const group = await create();
    unavailableMembers.add('lead');
    expect((await feature.list({ teamName: 'sandbox' }))[0]).toMatchObject({
      canSend: false, reason: 'recipient-unavailable: lead', availableRecipientNames: ['alice'],
    });
    const request = { teamName: 'sandbox', groupChatId: group.id, messageId: randomUUID(),
      text: 'Alice only', recipientName: 'alice' };
    await expect(feature.send({ ...request, messageId: randomUUID(), recipientName: 'lead' }))
      .rejects.toMatchObject({ code: 'recipient-unavailable' });
    const saved = await feature.send(request);
    expect(deliveries.map(row => row.to)).toEqual(['alice']);
    expect(saved.deliverySummary?.recipients.map(row => row.memberName)).toEqual(['alice']);
    await expect(feature.send({ ...request, messageId: randomUUID(), recipientName: 'bob' }))
      .rejects.toMatchObject({ code: 'invalid-recipient' });
    await expect(feature.send({ ...request, messageId: randomUUID() }, 'alice'))
      .rejects.toMatchObject({ code: 'invalid-input' });
    unavailableMembers.clear();
    const allRequest = { teamName: 'sandbox', groupChatId: group.id, messageId: randomUUID(),
      text: 'Everyone' };
    const allSaved = await feature.send(allRequest);
    expect(deliveries.map(row => row.to)).toEqual(['alice', 'lead', 'alice']);
    roster = ['lead', 'david'];
    runPrefix = 'replacement';
    available = false;
    expect(await feature.send(request)).toEqual(saved);
    expect(await feature.send(allRequest)).toEqual(allSaved);
    await expect(feature.send({ ...request, recipientName: undefined }))
      .rejects.toMatchObject({ code: 'conflicting-id' });
    await expect(feature.send({ ...request, recipientName: 'david' }))
      .rejects.toMatchObject({ code: 'conflicting-id' });
    await expect(feature.send({ ...allRequest, recipientName: 'lead' }))
      .rejects.toMatchObject({ code: 'conflicting-id' });
    const rows = JSON.parse(await readFile(join(state.root, 'sandbox', 'inboxes', 'user.json'), 'utf8')) as InboxMessage[];
    expect(rows.map(row => row.groupRecipientNames)).toEqual([['alice'], ['lead', 'alice']]);
    expect(rows[0].groupRecipientRunKeys).toEqual({ alice: 'run:alice' });
    expect(rows[1].groupRecipientRunKeys).toEqual({ lead: 'run:lead', alice: 'run:alice' });
    await feature.setArchived({ teamName: 'sandbox', groupChatId: group.id, archived: true });
    expect((await feature.list({ teamName: 'sandbox' }))[0].availableRecipientNames).toEqual([]);
    await expect(feature.send({ ...request, messageId: randomUUID(), recipientName: 'lead' }))
      .rejects.toMatchObject({ code: 'archived' });
    await feature.setArchived({ teamName: 'sandbox', groupChatId: group.id, archived: false });
    roster = ['lead'];
    await expect(feature.send({ ...request, messageId: randomUUID(), recipientName: 'lead' }))
      .rejects.toMatchObject({ code: 'minimum-members' });
    expect(deliveries).toHaveLength(3);
  });

  it('creates the reserved All destination only on human send and protects it from custom collisions/archive', async () => {
    expect(await feature.list({ teamName: 'sandbox' }, 'alice')).toEqual([]);
    await expect(feature.send({ teamName: 'sandbox', groupChatId: DEFAULT_TEAM_GROUP_CHAT_ID,
      messageId: randomUUID(), text: 'Agent cannot create' }, 'alice'))
      .rejects.toMatchObject({ code: 'not-found' });
    await expect(feature.create({ teamName: 'sandbox', id: DEFAULT_TEAM_GROUP_CHAT_ID,
      name: 'Custom', selectedMemberNames: ['lead', 'alice'], excludedMemberNames: [],
      autoIncludeNewMembers: false })).rejects.toMatchObject({ code: 'reserved-group' });
    roster = ['lead'];
    await expect(feature.send({ teamName: 'sandbox', groupChatId: DEFAULT_TEAM_GROUP_CHAT_ID,
      messageId: randomUUID(), text: 'Solo cannot send All' }))
      .rejects.toMatchObject({ code: 'minimum-members' });
    expect(await feature.list({ teamName: 'sandbox' })).toEqual([]);
    roster = ['lead', 'alice'];
    const request = { teamName: 'sandbox', groupChatId: DEFAULT_TEAM_GROUP_CHAT_ID,
      messageId: randomUUID(), text: 'Standard All' };
    const saved = await feature.send(request);
    expect(deliveries.map(row => row.to)).toEqual(['lead', 'alice']);
    expect(await feature.list({ teamName: 'sandbox' }, 'alice')).toEqual([
      expect.objectContaining({ id: DEFAULT_TEAM_GROUP_CHAT_ID, name: 'All agents',
        membership: { kind: 'auto', excludedMemberNames: [] }, memberNames: ['lead', 'alice'] }),
    ]);
    await expect(feature.setArchived({ teamName: 'sandbox', groupChatId: DEFAULT_TEAM_GROUP_CHAT_ID,
      archived: true })).rejects.toMatchObject({ code: 'reserved-group' });
    roster.push('bob');
    expect((await feature.list({ teamName: 'sandbox' }))[0].memberNames).toEqual(['lead', 'alice', 'bob']);
    expect(await feature.send(request)).toEqual(saved);
    expect(deliveries).toHaveLength(2);
    await feature.send({ ...request, messageId: randomUUID(), text: 'New member included' });
    expect(deliveries.slice(2).map(row => row.to)).toEqual(['lead', 'alice', 'bob']);
    const registry = join(state.root, 'sandbox', 'group-chats.json');
    const valid = JSON.parse(await readFile(registry, 'utf8'));
    valid.groups[0].membership = { kind: 'fixed', memberNames: ['lead', 'alice'] };
    await writeFile(registry, JSON.stringify(valid));
    await expect(feature.send({ ...request, messageId: randomUUID() }))
      .rejects.toMatchObject({ code: 'reserved-group' });
    expect(deliveries).toHaveLength(5);
  });

  it('preserves unrelated legacy group keys while rejecting partial current protocol rows', async () => {
    await create();
    const file = join(state.root, 'sandbox', 'inboxes', 'user.json');
    const legacy = {
      from: 'alice',
      to: 'user',
      text: 'Legacy DM',
      timestamp: new Date().toISOString(),
      read: false,
      groupId: 'old-custom-field',
    };
    await writeFile(file, JSON.stringify([legacy]));
    await send();
    const rows = JSON.parse(await readFile(file, 'utf8'));
    expect(rows[0]).toEqual(legacy);
    const controllerEnvelope = createRequire(import.meta.url)(
      '../../../agent-teams-controller/src/internal/groupEnvelope.js'
    ) as {
      assertValidGroupInboxRows(rows: unknown): void;
    };
    expect(() => controllerEnvelope.assertValidGroupInboxRows(rows)).not.toThrow();
    const corrupt = JSON.stringify([legacy, { groupRunKey: 'partial-current-protocol' }]);
    await writeFile(file, corrupt);
    await expect(
      feature.send({
        teamName: 'sandbox',
        groupChatId: '10000000-0000-4000-8000-000000000001',
        messageId: randomUUID(),
        text: 'Blocked',
      })
    ).rejects.toThrow('malformed group envelope');
    expect(() => controllerEnvelope.assertValidGroupInboxRows(JSON.parse(corrupt))).toThrow(
      'malformed group envelope'
    );
    expect(await readFile(file, 'utf8')).toBe(corrupt);
  });

  it('preserves corrupted storage bytes and prevents any dispatch', async () => {
    await create();
    const file = join(state.root, 'sandbox', 'inboxes', 'user.json');
    const bytes = '[{"groupChatId":"group-1","text":"truncated"}]';
    await writeFile(file, bytes);
    await expect(send()).rejects.toThrow('malformed group envelope');
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(deliveries).toHaveLength(0);
    await writeFile(file, 'null');
    await expect(send()).rejects.toThrow('expected array');
    expect(await readFile(file, 'utf8')).toBe('null');
    // Lossy decoding would turn this into valid JSON and allow a mutation.
    const invalidUtf8 = Buffer.concat([Buffer.from('[{"text":"'), Buffer.from([0xff]), Buffer.from('"}]')]);
    await writeFile(file, invalidUtf8);
    await expect(send()).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(await readFile(file)).toEqual(invalidUtf8);
    const registry = join(state.root, 'sandbox', 'group-chats.json');
    const registryBytes = await readFile(registry);
    const invalidRegistry = Buffer.from(registryBytes);
    invalidRegistry[registryBytes.indexOf('Release')] = 0xff;
    await writeFile(registry, invalidRegistry);
    await expect(feature.list({ teamName: 'sandbox' })).rejects.toMatchObject({ code: 'storage-unavailable' });
    await expect(create()).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(await readFile(registry)).toEqual(invalidRegistry);
    for (const corrupt of ['null', '{"version":2,"groups":[]}']) {
      await writeFile(registry, corrupt);
      await expect(feature.list({ teamName: 'sandbox' })).rejects.toMatchObject({ code: 'storage-unavailable' });
      await expect(create()).rejects.toMatchObject({ code: 'storage-unavailable' });
      expect(await readFile(registry, 'utf8')).toBe(corrupt);
    }
    expect(deliveries).toHaveLength(0);
  });

  it('rejects invalid canonical IDs before registry or inbox writes and leaves stored legacy groups alone', async () => {
    const registry = join(state.root, 'sandbox', 'group-chats.json');
    const inbox = join(state.root, 'sandbox', 'inboxes', 'user.json');
    const group = await create();
    await send();
    const beforeRegistry = await readFile(registry);
    const beforeInbox = await readFile(inbox);
    const beforeFanout = deliveries.length;
    for (const invalid of ['group-1', 'opencode-plain-reply-ledger', '20000000-0000-4000-8000-000000000001:g:memberhash', '20000000-0000-4000-7000-000000000001', '20000000-0000-9000-8000-000000000001']) {
      await expect(feature.create({ teamName: 'sandbox', id: invalid, name: 'Invalid', selectedMemberNames: ['lead', 'alice'], excludedMemberNames: [], autoIncludeNewMembers: false })).rejects.toMatchObject({ code: 'invalid-input' });
      await expect(feature.send({ teamName: 'sandbox', groupChatId: invalid, messageId: randomUUID(), text: 'Invalid group' })).rejects.toMatchObject({ code: 'invalid-input' });
      await expect(feature.send({ teamName: 'sandbox', groupChatId: group.id, messageId: invalid, text: 'Invalid post' })).rejects.toMatchObject({ code: 'invalid-input' });
      await expect(feature.setArchived({ teamName: 'sandbox', groupChatId: invalid, archived: true })).rejects.toMatchObject({ code: 'invalid-input' });
      expect(await readFile(registry)).toEqual(beforeRegistry);
      expect(await readFile(inbox)).toEqual(beforeInbox);
    }
    expect(deliveries).toHaveLength(beforeFanout);
    // Existing groups remain readable; stricter command admission never migrates them.
    const legacyBytes = Buffer.from(JSON.stringify({ version: 1, groups: [{ ...group, id: 'legacy-group' }] }));
    await writeFile(registry, legacyBytes);
    expect((await feature.list({ teamName: 'sandbox' }))[0].id).toBe('legacy-group');
    expect(await readFile(registry)).toEqual(legacyBytes);
  });

  it('materializes the actual service group fallback as a stable UUID through real feature and inbox writes without repeat fanout', async () => {
    const writer = new TeamInboxWriter();
    deliver = async (team, message, _run, shouldStillWrite) => {
      deliveries.push(message);
      await writer.sendMessage(team, { ...message, attachments: undefined, member: message.to }, { shouldStillWrite });
      return 'accepted';
    };
    const group = await create();
    await send();
    const physical = deliveries.find((message) => message.to === 'alice')!;
    expect(physical.messageId).toMatch(/:g:[0-9a-f]{24}$/);
    const ledger = createOpenCodePromptDeliveryLedgerStore({ filePath: join(state.root, 'sandbox', 'test-ledger.json') });
    const now = '2026-10-10T12:00:00.000Z';
    const pending = await ledger.ensurePending({ teamName: 'sandbox', memberName: 'alice', laneId: 'test-lane', groupChatId: group.id, inboxMessageId: physical.messageId!, inboxTimestamp: physical.timestamp, source: 'watcher', replyRecipient: 'user', payloadHash: 'test-group-payload', now });
    const record = await ledger.applyObservation({ id: pending.id, responseObservation: {
      state: 'responded_plain_text', deliveredUserMessageId: 'test-prompt', assistantMessageId: 'test-answer', toolCallNames: [], visibleMessageToolCallId: null, visibleReplyMessageId: null, visibleReplyCorrelation: null, latestAssistantPreview: 'Concrete group answer — 日本語', reason: null,
    }, observedAt: now });
    const service = new OpenCodeVisibleReplyProofService({ inboxReader: new TeamInboxReader(), inboxWriter: writer, getConfiguredLeadName: async () => 'lead', emitRuntimeDeliveryReplyAdvisoryRefresh: () => {}, warn: () => {}, getErrorMessage: String,
      sendGroupChatReply: ({ from, ...request }) => feature.send(request, from),
    });
    const materialize = () => service.materializePlainTextReplyIfNeeded({ teamName: 'sandbox', memberName: 'alice', ledger, ledgerRecord: record });
    const first = await materialize();
    const uuid = first.visibleReply?.message.messageId;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid).toBe(buildGroupPlainTextVisibleReplyMessageId(record));
    expect(buildGroupPlainTextVisibleReplyMessageId({ ...record, observedAssistantPreview: 'changed text', updatedAt: now })).toBe(uuid);
    for (const changed of [{ groupChatId: randomUUID() }, { id: `${record.id}-other` }, { inboxMessageId: `${record.inboxMessageId}-other` }]) {
      expect(buildGroupPlainTextVisibleReplyMessageId({ ...record, ...changed })).not.toBe(uuid);
    }
    expect(buildPlainTextVisibleReplyMessageId({ ...record, id: 'dm-ledger' })).toBe('opencode-plain-reply-dm-ledger');
    expect((await ledger.getByInboxMessage(record))?.visibleReplyMessageId).toBe(uuid);
    expect(deliveries).toHaveLength(3);
    const inbox = join(state.root, 'sandbox', 'inboxes', 'user.json');
    const savedBytes = await readFile(inbox);
    const rows = JSON.parse(savedBytes.toString('utf8')) as InboxMessage[];
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ messageId: uuid, groupMessageId: uuid, groupChatId: group.id, from: 'alice', relayOfMessageId: physical.messageId, text: 'Concrete group answer — 日本語' });
    const leadRows = JSON.parse(await readFile(join(state.root, 'sandbox', 'inboxes', 'lead.json'), 'utf8')) as InboxMessage[];
    expect(leadRows[1]).toMatchObject({ messageId: rows[1].groupDeliverySummary!.recipients[0].physicalMessageId, groupMessageId: uuid, relayOfMessageId: physical.messageId });
    expect((await materialize()).visibleReply?.message.messageId).toBe(uuid);
    expect(await readFile(inbox)).toEqual(savedBytes);
    expect(deliveries).toHaveLength(3);
  });

  it('uses the same HTTP owner for trusted human identity, explicit proactive agent destination and archive errors', async () => {
    const app = Fastify();
    registerTeamGroupChatsHttp(app, feature);
    try {
      await create();
      const post = (url: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url, payload: body });
      const human = await post('/api/team-group-chats/send', {
        teamName: 'sandbox', groupChatId: '10000000-0000-4000-8000-000000000001', messageId: '20000000-0000-4000-8000-000000000002', text: 'Human', from: 'alice',
      });
      expect(human.statusCode).toBe(200);
      expect(deliveries.map((row) => row.from)).toEqual(['user', 'user']);
      deliveries.length = 0;
      const proactive = { from: 'alice', groupChatId: '10000000-0000-4000-8000-000000000001', messageId: '20000000-0000-4000-8000-000000000003', text: 'Proactive' };
      const agent = await post('/api/teams/sandbox/group-chats/send', proactive);
      expect(agent.statusCode).toBe(200);
      expect(deliveries.map((row) => [row.from, row.to, row.groupChatId])).toEqual([['alice', 'lead', '10000000-0000-4000-8000-000000000001']]);
      const selected = await post('/api/team-group-chats/send', { ...proactive, teamName: 'sandbox',
        messageId: randomUUID(), recipientName: 'alice' });
      expect(selected.statusCode).toBe(200);
      expect(deliveries.at(-1)).toMatchObject({ from: 'user', to: 'alice' });
      const rejectedTarget = await post('/api/teams/sandbox/group-chats/send', { ...proactive,
        messageId: randomUUID(), recipientName: 'lead' });
      expect(rejectedTarget.json().error.code).toBe('invalid-input');
      const nonmember = await post('/api/teams/sandbox/group-chats/send', { ...proactive, from: 'bob', messageId: '20000000-0000-4000-8000-000000000004' });
      expect(nonmember.json().error.code).toBe('not-member');
      await feature.setArchived({ teamName: 'sandbox', groupChatId: '10000000-0000-4000-8000-000000000001', archived: true });
      const archived = await post('/api/teams/sandbox/group-chats/send', { ...proactive, messageId: '20000000-0000-4000-8000-000000000005' });
      expect(archived.statusCode).toBe(400);
      expect(archived.json().error.code).toBe('archived');
      const retry = await post('/api/teams/sandbox/group-chats/send', proactive);
      expect(retry.json()).toEqual(agent.json());
      expect(deliveries).toHaveLength(2);
      const rows = JSON.parse(await readFile(join(state.root, 'sandbox', 'inboxes', 'user.json'), 'utf8')) as InboxMessage[];
      expect(rows.map((row) => [row.from, row.to, row.groupChatId])).toEqual([
        ['user', 'user', '10000000-0000-4000-8000-000000000001'], ['alice', 'user', '10000000-0000-4000-8000-000000000001'],
        ['user', 'user', '10000000-0000-4000-8000-000000000001'],
      ]);
    } finally { await app.close(); }
  });

  it('runs bounded IPC/controller/MCP transport with native/OpenCode destinations beside DM (processor boundary is synthetic)', async () => {
    // No capability rows or provider process are fabricated. Runtime admission and
    // model processing are injected transport ports, not live-runtime evidence.
    const claudeDir = state.root;
    const originalRoot = state.root;
    state.root = join(claudeDir, 'teams');
    await mkdir(join(state.root, 'sandbox', 'inboxes'), { recursive: true });
    await writeFile(join(state.root, 'sandbox', 'config.json'), JSON.stringify({
      name: 'sandbox', members: roster.map(name => ({ name, agentType: name === 'lead' ? 'team-lead' : 'teammate' })),
    }));
    const { createController } = createRequire(import.meta.url)(
      '../../../agent-teams-controller/src/controller.js'
    ) as typeof import('agent-teams-controller');
    const controller = createController({ teamName: 'sandbox', claudeDir });
    let locked!: () => void;
    const groupLocked = new Promise<void>(resolve => { locked = resolve; });
    let release!: () => void;
    const holdGroup = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const writer = new TeamInboxWriter();
    feature = createTeamGroupChatsFeature({ roster: async () => roster,
      getRun: async (_team, member) => ({ runKey: `synthetic:${member}`, protocolVersion: 1,
        provider: member === 'alice' ? 'opencode' : 'native', isCurrent: async () => true }),
      configurationOperation: (_team, operation) => operation(),
      deliver: async (team, message, _run, shouldStillWrite) => {
        deliveries.push(message);
        const sent = await writer.sendMessage(team, { ...message, attachments: undefined, member: message.to }, {
          shouldStillWrite: async () => {
            if (message.to === 'alice' && message.text === 'GROUP_TEXT' && !held) {
              held = true;
              locked();
              await holdGroup;
            }
            return shouldStillWrite();
          },
        });
        return sent.deliveredToInbox ? 'accepted' : 'skipped';
      },
    });
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<{ result?: unknown; error?: unknown }>>();
    registerTeamGroupChatsIpc({ handle: (name: string, handler: (event: unknown, input: unknown) => Promise<{ result?: unknown; error?: unknown }>) => handlers.set(name, handler) } as unknown as import('electron').IpcMain, feature);
    const ipc = (method: keyof typeof GROUP_CHAT_CHANNELS, input: object) => handlers.get(GROUP_CHAT_CHANNELS[method])!(null, { teamName: 'sandbox', ...input });
    const app = Fastify();
    registerTeamGroupChatsHttp(app, feature);
    const id = randomUUID();
    const context = { appInstanceId: 'synthetic-transport', dataRootFingerprint: claudeDir, connectionGeneration: 1 };
    // Reuse the existing stdio fixture against the actual production MCP server.
    // Each new child captures its bound context and negotiates tools over JSON-RPC.
    const mcp = async (tool: string, input: object) => {
      const client = new McpStdIoClient(resolve('mcp-server/dist/index.js'), resolve('.'),
        ['--transport', 'stdio'], {
          AGENT_TEAMS_MCP_CLAUDE_DIR: claudeDir,
          AGENT_TEAMS_BOUND_CONTROL_URL: app.listeningOrigin,
          AGENT_TEAMS_BOUND_CONTEXT_JSON: JSON.stringify(context),
        });
      try {
        await client.initialize();
        const discovery = await client.listTools() as { result: { tools: { name: string }[] } };
        expect(discovery.result.tools.map(item => item.name)).toEqual(expect.arrayContaining(['group_chat_list', 'group_chat_send']));
        const response = await client.callTool(tool, { teamName: 'sandbox', from: 'alice', ...input }) as {
          result?: { content: { text: string }[]; isError?: boolean }; error?: unknown;
        };
        expect(response.error).toBeUndefined();
        expect(response.result?.isError).not.toBe(true);
        return JSON.parse(response.result!.content[0].text);
      } finally { await client.close(); }
    };
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      expect((await ipc('create', { id, name: 'Transport', selectedMemberNames: ['lead', 'alice'],
        excludedMemberNames: ['bob'], autoIncludeNewMembers: true })).error).toBeUndefined();
      const groupPost = ipc('send', { groupChatId: id, messageId: randomUUID(), text: 'GROUP_TEXT' });
      await groupLocked;
      // The controller must yield while the same-process async group writer owns the file.
      const releaseTimer = setTimeout(release, 25);
      try {
        const [posted, privateReply] = await Promise.all([
          groupPost,
          controller.messages.sendMessageAsync({ member: 'alice', from: 'user', text: 'PRIVATE_DM', messageId: 'private-dm' }),
        ]);
        expect(posted.error).toBeUndefined();
        expect(privateReply).toMatchObject({ deliveredToInbox: true, messageId: 'private-dm' });
        expect(await controller.messages.sendMessageAsync({ member: 'alice', from: 'user', text: 'PRIVATE_DM', messageId: 'private-dm' })).toMatchObject({ deduplicated: true, messageId: 'private-dm' });
        await expect(controller.messages.sendMessageAsync({ member: 'alice', from: 'user', text: 'BLOCK PRIVATE GROUP REPLY', groupChatId: id })).rejects.toThrow('group_chat_send');
      } finally {
        clearTimeout(releaseTimer);
        release();
      }
      const inbound = deliveries.find(message => message.to === 'alice')!;
      const reply = await mcp('group_chat_send', { groupChatId: id, messageId: randomUUID(), text: 'GROUP_REPLY', relayOfMessageId: inbound.messageId });
      expect(reply).toMatchObject({ saved: true, groupChatId: id, relayOfMessageId: inbound.messageId });
      expect(await mcp('group_chat_send', { groupChatId: id, messageId: randomUUID(), text: 'PROACTIVE' })).toMatchObject({ saved: true });
      await ipc('setArchived', { groupChatId: id, archived: true });
      roster.push('carol');
      const catalog = await mcp('group_chat_list', {});
      expect(catalog[0]).toMatchObject({ id, reason: 'archived', memberNames: ['lead', 'alice', 'carol'] });
      expect(await mcp('group_chat_send', { groupChatId: id, messageId: randomUUID(), text: 'BLOCKED' })).toMatchObject({ error: { code: 'archived' } });
      await ipc('setArchived', { groupChatId: id, archived: false });
      // Fresh discovery after a new child/tool registration simulates compaction
      // discovery transport; actual runtime compaction remains unproven.
      expect((await mcp('group_chat_list', {}))[0]).toMatchObject({ id, canSend: true });
      const canonical = JSON.parse(await readFile(join(state.root, 'sandbox', 'inboxes', 'user.json'), 'utf8'));
      expect(canonical.map((message: InboxMessage) => message.text)).toEqual(['GROUP_TEXT', 'GROUP_REPLY', 'PROACTIVE']);
      expect(canonical.every((message: InboxMessage) => message.groupChatId === id)).toBe(true);
      const physical = JSON.parse(await readFile(join(state.root, 'sandbox', 'inboxes', 'alice.json'), 'utf8'));
      expect(physical.find((message: InboxMessage) => message.messageId === 'private-dm')).toMatchObject({ text: 'PRIVATE_DM' });
    } finally {
      await app.close();
      state.root = originalRoot;
    }
  });

  it('validates group reply correlation', async () => {
    await create();
    const physical: InboxMessage = {
      from: 'user',
      to: 'lead',
      text: 'Inbound',
      timestamp: new Date().toISOString(),
      read: false,
      messageId: 'physical-1',
      groupChatId: '10000000-0000-4000-8000-000000000001',
      groupMessageId: '20000000-0000-4000-8000-000000000007',
      groupRunKey: 'run:lead',
      groupChatProtocolVersion: 1,
    };
    await writeFile(
      join(state.root, 'sandbox', 'inboxes', 'lead.json'),
      JSON.stringify([physical])
    );
    await expect(
      feature.send(
        {
          teamName: 'sandbox',
          groupChatId: '10000000-0000-4000-8000-000000000001',
          messageId: '20000000-0000-4000-8000-000000000006',
          text: 'Reply',
          relayOfMessageId: 'missing',
        },
        'lead'
      )
    ).rejects.toMatchObject({ code: 'invalid-relay' });
    const reply = await feature.send(
      {
        teamName: 'sandbox',
        groupChatId: '10000000-0000-4000-8000-000000000001',
        messageId: '20000000-0000-4000-8000-000000000006',
        text: 'Reply',
        relayOfMessageId: 'physical-1',
      },
      'lead'
    );
    expect(reply.saved).toBe(true);
    expect(deliveries.map((row) => row.to)).toEqual(['alice']);
  });
});

it('admits native groups only against a bound listener and an exact current live capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-group-proof-'));
  let available = true;
  let replacement = false;
  let reads = 0;
  const revoke = configureDesktopMcpEnvironment(() => ({}), () => available);
  try {
    const dir = join(root, 'sandbox', 'members', encodeTeamMemberStorageKey('lead'), '.member-work-sync', 'runtime-admission');
    await mkdir(dir, { recursive: true });
    const proof = { teamName: 'sandbox', memberName: 'lead', processorReady: true,
      bootstrapRunId: 'actual-test-run', pid: process.pid, groupChatProtocolVersion: 1,
      groupRunKey: `actual-test-run:${process.pid}` };
    const file = join(dir, 'capability.json');
    await writeFile(file, JSON.stringify(proof));
    const { getRun } = createGroupChatRuntimePorts({ teamsBasePath: root,
      getTeamAgentRuntimeSnapshot: async () => ({ teamName: 'sandbox', runId: 'actual-test-run',
        updatedAt: new Date().toISOString(), members: { lead: { memberName: 'lead',
          alive: !(replacement && ++reads === 2), restartable: true, backendType: 'lead',
          providerId: 'anthropic', pid: process.pid, updatedAt: new Date().toISOString() } } }),
    });
    expect(await getRun('sandbox', 'lead')).toEqual({ runKey: proof.groupRunKey, protocolVersion: 1, provider: 'lead' });
    available = false;
    expect(await getRun('sandbox', 'lead')).toBeNull();
    available = true;
    await writeFile(file, JSON.stringify({ ...proof, bootstrapRunId: 'old-run', groupRunKey: `old-run:${process.pid}` }));
    expect(await getRun('sandbox', 'lead')).toBeNull();
    await writeFile(file, JSON.stringify({ ...proof, groupChatProtocolVersion: 0 }));
    expect(await getRun('sandbox', 'lead')).toBeNull();
    await writeFile(file, JSON.stringify(proof));
    replacement = true;
    reads = 0;
    expect(await getRun('sandbox', 'lead')).toBeNull();
  } finally { revoke(); await rm(root, { recursive: true, force: true }); }
});

// Synthetic process fixture exercises the actual handshake validator.
describe('OpenCode group current-run admission', () => {
  it('requires a live handshake, then commits with local owner fences without probing under the inbox lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-group-proof-'));
    const previousRoot = state.root;
    state.root = root;
    let available = true;
    const revoke = configureDesktopMcpEnvironment(() => ({}), () => available);
    try {
      await mkdir(join(root, 'sandbox', 'inboxes'), { recursive: true });
      const clientIdentity = createOpenCodeBridgeClientIdentity({ appVersion: 'test' });
      let sessionId = 'session-1';
      let runtimePid = process.pid;
      let highWatermark = 0;
      let handshakes = 0;
      let writes = 0;
      let protocol: 1 | undefined = 1;
      const proof = { teamName: 'sandbox', memberName: 'alice', runId: 'run-1', runKey: 'run-1',
        laneId: 'primary', runtimeSessionId: 'session-1', runtimePid: process.pid, processorReady: true };
      const getter = createOpenCodeGroupChatRunGetter({
        clientIdentity,
        snapshot: async () => ({ teamName: 'sandbox', runId: 'run-1', updatedAt: new Date().toISOString(),
          members: { alice: { memberName: 'alice', alive: true, restartable: true, providerId: 'opencode', cwd: '/synthetic',
            laneId: 'primary', pid: runtimePid, runtimePid,
            runtimeSessionId: sessionId, updatedAt: new Date().toISOString() } } }),
        manifest: { read: async () => ({ activeRunId: 'run-1', capabilitySnapshotId: 'cap-1', highWatermark }) },
        handshake: { handshake: async () => {
          expect(writes, 'full handshake must stay outside the physical inbox write').toBe(0);
          handshakes++;
          const handshake: OpenCodeBridgeHandshake = { schemaVersion: 1, requestId: 'test-handshake',
            client: clientIdentity, server: { ...clientIdentity, peer: 'agent_teams_orchestrator',
              bridgeProtocol: { ...clientIdentity.bridgeProtocol, groupChatProtocolVersion: protocol },
              runtime: { ...clientIdentity.runtime, activeRunId: 'run-1', capabilitySnapshotId: 'cap-1',
                runtimeStoreManifestHighWatermark: 0, groupChatRunProof: proof } },
            agreedProtocolVersion: 1, acceptedCommands: ['opencode.sendMessage'],
            serverTime: new Date().toISOString(), identityHash: '' };
          handshake.identityHash = createOpenCodeBridgeHandshakeIdentityHash(handshake);
          return handshake;
        } },
      });
      const admitted = await getter('sandbox', 'alice');
      expect(admitted).toMatchObject({ runKey: 'run-1', protocolVersion: 1, provider: 'opencode' });
      const writer = new TeamInboxWriter();
      const feature = createTeamGroupChatsFeature({
        roster: async () => ['alice', 'bob'],
        getRun: async (team, name) => name === 'alice' ? getter(team, name)
          : { runKey: 'native:bob', protocolVersion: 1, provider: 'native' },
        configurationOperation: (_team, operation) => operation(),
        deliver: async (team, message, _run, shouldStillWrite) => {
          writes++;
          try {
            const sent = await writer.sendMessage(team, { ...message, attachments: undefined, member: message.to }, { shouldStillWrite });
            return sent.deliveredToInbox ? 'queued' : 'skipped';
          } finally { writes--; }
        },
      });
      const group = await feature.create({ teamName: 'sandbox', id: randomUUID(), name: 'Proof',
        selectedMemberNames: ['alice', 'bob'], excludedMemberNames: [], autoIncludeNewMembers: false });
      const beforeSend = handshakes;
      const sent = await feature.send({ teamName: 'sandbox', groupChatId: group.id, messageId: randomUUID(), text: 'Current owner only' });
      expect(sent.deliverySummary!.recipients.every(recipient => recipient.status === 'queued')).toBe(true);
      expect(handshakes).toBe(beforeSend + 1); // One fresh admission, no per-write probes.
      expect(JSON.parse(await readFile(join(root, 'sandbox', 'inboxes', 'alice.json'), 'utf8'))).toHaveLength(1);

      const beforeFences = handshakes;
      expect(await admitted!.isCurrent!()).toBe(true);
      sessionId = 'replacement-session';
      expect(await admitted!.isCurrent!()).toBe(false);
      sessionId = 'session-1';
      runtimePid++;
      expect(await admitted!.isCurrent!()).toBe(false);
      runtimePid = process.pid;
      highWatermark++;
      expect(await admitted!.isCurrent!()).toBe(false);
      highWatermark = 0;
      available = false;
      expect(await admitted!.isCurrent!()).toBe(false);
      available = true;
      expect(handshakes).toBe(beforeFences);
      sessionId = '';
      expect(await getter('sandbox', 'alice')).toBeNull();
      expect(handshakes).toBe(beforeFences); // Missing bound session cannot probe bootstrap.
      sessionId = 'session-1';
      protocol = undefined;
      expect(await getter('sandbox', 'alice')).toBeNull();
    } finally { revoke(); state.root = previousRoot; await rm(root, { recursive: true, force: true }); }
  });
});
