import { createDesktopTeamGroupChats } from '@features/team-group-chats/main/composition/createDesktopTeamGroupChats';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { extractAgentBlockContents, stripAgentBlocks } from '@shared/constants/agentBlocks';
import { protocols } from 'agent-teams-controller';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupChatRun } from '../../../src/features/team-group-chats/main/composition/createTeamGroupChatsFeature';
import type { InboxMessage } from '../../../src/shared/types/team';

const state = vi.hoisted(() => ({ root: '', getRun: vi.fn() }));
vi.mock('@main/utils/pathDecoder', async (original) => ({
  ...(await original<object>()),
  getTeamsBasePath: () => state.root,
}));
// Runtime admission is synthetic; the desktop composition, canonical storage, and inbox writer are real.
vi.mock('@features/team-group-chats/main/infrastructure/groupChatRuntimePorts', () => ({
  createGroupChatRuntimePorts: () => ({ getRun: state.getRun }),
}));

describe('desktop group visualization discovery delivery', () => {
  const groupChatId = '10000000-0000-4000-8000-000000000001';
  const messageId = '20000000-0000-4000-8000-000000000001';
  const members = ['lead', 'alice', 'bob'];

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'group-visualization-delivery-'));
    await mkdir(join(state.root, 'sandbox', 'inboxes'), { recursive: true });
    await writeFile(
      join(state.root, 'sandbox', 'config.json'),
      JSON.stringify({ name: 'sandbox', members: members.map((name) => ({ name })) })
    );
    state.getRun.mockImplementation((_team: string, name: string): Promise<GroupChatRun> => {
      let provider: GroupChatRun['provider'] = 'native';
      if (name === 'lead') provider = 'lead';
      if (name === 'bob') provider = 'opencode';
      return Promise.resolve({
        runKey: `run:${name}`,
        protocolVersion: 1,
        provider,
        ...(provider === 'opencode' ? { isCurrent: async () => true } : {}),
      });
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    state.getRun.mockReset();
    await rm(state.root, { recursive: true, force: true });
  });

  async function inbox(member: string): Promise<InboxMessage[]> {
    return JSON.parse(
      await readFile(join(state.root, 'sandbox', 'inboxes', `${member}.json`), 'utf8')
    );
  }

  it('adds the hint only to native human deliveries while preserving canonical identity, replay, and group replies', async () => {
    const writer = new TeamInboxWriter();
    const physicalWrite = vi.spyOn(writer, 'sendMessage');
    const feature = createDesktopTeamGroupChats({
      leadName: () => Promise.resolve('lead'),
      snapshot: () =>
        Promise.resolve({
          teamName: 'sandbox',
          runId: null,
          updatedAt: new Date().toISOString(),
          members: {},
        }),
      openCodeRun: () => Promise.resolve(null),
      configurationOperation: (_team, operation) => operation(),
      inboxWriter: writer,
      changed: vi.fn(),
      reactionChanged: vi.fn(),
    });
    await feature.create({
      teamName: 'sandbox',
      id: groupChatId,
      name: 'Charts',
      selectedMemberNames: members,
      excludedMemberNames: [],
      autoIncludeNewMembers: false,
    });
    const request = {
      teamName: 'sandbox',
      groupChatId,
      messageId,
      text: 'Show four charts here using OpenUI.\n\nUse the current project data.',
      summary: 'Inline dashboard',
      taskRefs: [{ teamName: 'sandbox', taskId: '1', displayId: '#1' }],
    };
    const sent = await feature.send(request);
    expect(sent).toMatchObject({ saved: true, statusPersisted: true });
    const canonical = await inbox('user');
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({
      from: 'user',
      to: 'user',
      source: 'user_sent',
      text: request.text,
      messageId,
      groupMessageId: messageId,
      groupChatId,
      groupRecipientNames: members,
    });

    const hint = protocols.buildChatVisualizationRefreshInstruction();
    const delivered = new Map<string, InboxMessage>();
    for (const member of members) {
      const rows = await inbox(member);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      delivered.set(member, row);
      expect(row).toMatchObject({
        from: 'user',
        to: member,
        source: 'user_sent',
        groupChatId,
        groupChatName: 'Charts',
        groupMessageId: messageId,
        groupChatProtocolVersion: 1,
        groupRunKey: `run:${member}`,
        summary: request.summary,
        taskRefs: request.taskRefs,
        groupRecipientNames: members,
        groupRecipientRunKeys: { lead: 'run:lead', alice: 'run:alice', bob: 'run:bob' },
      });
      expect(row.messageId).toMatch(new RegExp(`^${messageId}:g:[a-f0-9]{24}$`));
      expect(stripAgentBlocks(row.text)).toBe(request.text);
      expect(extractAgentBlockContents(row.text)).toEqual(member === 'bob' ? [] : [hint]);
      if (member === 'bob') expect(row.text).toBe(request.text);
    }

    // Replay compares the unchanged canonical payload and never re-fans out physical text.
    expect(await feature.send(request)).toEqual(sent);
    expect(physicalWrite).toHaveBeenCalledTimes(members.length);
    expect(await inbox('user')).toEqual(canonical);
    for (const member of members) expect(await inbox(member)).toEqual([delivered.get(member)]);

    const replyId = '30000000-0000-4000-8000-000000000001';
    const reply = 'The inline dashboard is ready.';
    const relayOfMessageId = delivered.get('alice')!.messageId!;
    expect(
      await feature.send(
        {
          teamName: 'sandbox',
          groupChatId,
          messageId: replyId,
          text: reply,
          relayOfMessageId,
        },
        'alice'
      )
    ).toMatchObject({ saved: true, statusPersisted: true });
    for (const member of ['lead', 'bob']) {
      const rows = await inbox(member);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        from: 'alice',
        to: member,
        source: 'runtime_delivery',
        text: reply,
        groupChatId,
        groupMessageId: replyId,
        relayOfMessageId,
      });
      expect(extractAgentBlockContents(rows[1].text)).toEqual([]);
    }
    expect(await inbox('alice')).toEqual([delivered.get('alice')]);
  });
});
