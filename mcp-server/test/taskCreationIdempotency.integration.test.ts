import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as controllerModule from '../src/controller';

import { registerTools } from '../src/tools';

type RegisteredTool = {
  description?: string;
  name: string;
  parameters?: { safeParse: (value: unknown) => { success: boolean } };
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

function collectTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  registerTools({
    addTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as never);
  return tools;
}

function parseJsonToolResult(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
  return JSON.parse(text ?? '{}') as Record<string, unknown>;
}

describe('MCP task creation idempotency', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTeam(teamName: string): string {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-mcp-idempotency-'));
    tempDirs.push(claudeDir);
    const teamDir = path.join(claudeDir, 'teams', teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        members: [{ name: 'lead', role: 'team-lead' }],
      })
    );
    return claudeDir;
  }

  function taskFiles(claudeDir: string, teamName: string): string[] {
    return fs
      .readdirSync(path.join(claudeDir, 'tasks', teamName))
      .filter((fileName) => fileName.endsWith('.json'));
  }

  // Inject only the existing catalog port; task storage/provenance/idempotency remain real.
  function catalogFixture(teamName: string) {
    const original = controllerModule.getController;
    const groups = [
      { id: '00000000-0000-4000-8000-000000000001', archivedAt: null as string | null },
      { id: '11111111-1111-4111-8111-111111111111', archivedAt: null as string | null },
    ];
    let unavailable = false;
    const list = vi.fn(async (flags: Record<string, unknown>) => {
      expect(flags.from).toBe('lead');
      if (unavailable) throw new Error('Catalog unavailable');
      return groups;
    });
    vi.spyOn(controllerModule, 'getController').mockImplementation((team, dir) => {
      const controller = original(team, dir);
      controller.groupChats.listGroupChats = team === teamName ? list : async () => [];
      return controller;
    });
    return {
      groups,
      list,
      fail: () => {
        unavailable = true;
      },
    };
  }

  it('admits associated tasks through the active team catalog and replays before mutable catalog checks', async () => {
    const teamName = 'associated-create';
    const claudeDir = makeTeam(teamName);
    const catalog = catalogFixture(teamName);
    const tools = collectTools();
    const create = tools.get('task_create')!;
    const request = {
      teamName,
      claudeDir,
      subject: 'Associated work',
      createdBy: 'lead',
      groupChatId: catalog.groups[0]!.id,
      idempotencyKey: 'associated-intent',
    };
    const first = parseJsonToolResult(await create.execute(request));
    expect(first.groupChatId).toBe(request.groupChatId);
    expect(
      parseJsonToolResult(
        await tools.get('task_get')!.execute({ teamName, claudeDir, taskId: first.id })
      ).groupChatId
    ).toBe(request.groupChatId);
    expect(
      parseJsonToolResult(await tools.get('task_list')!.execute({ teamName, claudeDir }))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, groupChatId: request.groupChatId }),
      ])
    );
    await expect(
      create.execute({ ...request, idempotencyKey: 'no-actor', createdBy: 'user' })
    ).rejects.toThrow('configured non-user');
    await expect(
      create.execute({
        ...request,
        idempotencyKey: 'foreign',
        groupChatId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toThrow('group in this team');
    catalog.groups[0]!.archivedAt = '2026-10-10T00:00:00.000Z';
    await expect(create.execute({ ...request, idempotencyKey: 'fresh-archived' })).rejects.toThrow(
      'archived group'
    );
    const calls = catalog.list.mock.calls.length;
    catalog.fail();
    expect(parseJsonToolResult(await collectTools().get('task_create')!.execute(request)).id).toBe(
      first.id
    );
    await expect(
      create.execute({ ...request, groupChatId: catalog.groups[1]!.id })
    ).rejects.toThrow('Task creation command conflict');
    expect(catalog.list).toHaveBeenCalledTimes(calls);
    expect(taskFiles(claudeDir, teamName)).toHaveLength(1);
  });

  it('infers group context only from the original canonical user message and rejects conflicting targets/relays', async () => {
    const teamName = 'associated-message';
    const claudeDir = makeTeam(teamName);
    const catalog = catalogFixture(teamName);
    const originalId = '33333333-3333-4333-8333-333333333333';
    const original = {
      messageId: originalId,
      groupMessageId: originalId,
      groupChatId: catalog.groups[0]!.id,
      groupChatProtocolVersion: 1,
      from: 'user',
      to: 'user',
      text: 'Group request',
      timestamp: '2026-10-10T00:00:00.000Z',
      source: 'user_sent',
      read: false,
      groupRecipientNames: ['lead'],
      groupRecipientRunKeys: { lead: 'run:lead' },
    };
    const inbox = path.join(claudeDir, 'teams', teamName, 'inboxes');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'user.json'), JSON.stringify([original]));
    fs.writeFileSync(
      path.join(inbox, 'lead.json'),
      JSON.stringify([
        { ...original, messageId: 'physical-group-relay', to: 'lead', groupRunKey: 'run:lead' },
      ])
    );
    const create = collectTools().get('task_create_from_message')!;
    const request = {
      teamName,
      claudeDir,
      messageId: originalId,
      requestKey: 'group-intent',
      subject: 'Inferred association',
      createdBy: 'lead',
    };
    const first = parseJsonToolResult(await create.execute(request));
    expect(first.groupChatId).toBe(original.groupChatId);
    await expect(
      create.execute({
        ...request,
        requestKey: 'conflicting-source',
        groupChatId: catalog.groups[1]!.id,
      })
    ).rejects.toThrow('must agree with the original');
    await expect(
      create.execute({
        ...request,
        requestKey: 'physical-source',
        messageId: 'physical-group-relay',
      })
    ).rejects.toThrow('relay copy');
    catalog.groups[0]!.archivedAt = '2026-10-10T00:00:00.000Z';
    catalog.fail();
    expect(
      parseJsonToolResult(await collectTools().get('task_create_from_message')!.execute(request)).id
    ).toBe(first.id);
    expect(taskFiles(claudeDir, teamName)).toHaveLength(1);
  });

  it('keeps new idempotency fields optional and validates explicit identities', () => {
    const tools = collectTools();
    expect(tools.get('task_create')!.description).toContain(
      'Always provide a stable idempotencyKey'
    );
    expect(tools.get('task_create_from_message')!.description).toContain(
      'Always provide a stable requestKey'
    );
    expect(
      tools.get('task_create')!.parameters?.safeParse({
        teamName: 'alpha',
        subject: 'Keyed task',
        commandId: '019cce7c-f940-4777-8777-777777777777',
        idempotencyKey: '019cce7c-f940-4777-8777-777777777777',
      }).success
    ).toBe(true);
    expect(
      tools.get('task_create')!.parameters?.safeParse({
        teamName: 'alpha',
        subject: 'Non-canonical task id',
        commandId: '019cce7c-f940-7777-8777-777777777777',
      }).success
    ).toBe(false);
    expect(
      tools.get('task_create_from_message')!.parameters?.safeParse({
        teamName: 'alpha',
        messageId: 'msg-1',
        requestKey: 'ui-task',
        subject: 'Task from message',
      }).success
    ).toBe(true);
    expect(
      tools.get('task_create')!.parameters?.safeParse({
        teamName: 'alpha',
        subject: 'Legacy unkeyed task',
      }).success
    ).toBe(true);
  });

  it('coalesces duplicate and concurrent task_create calls by explicit command identity', async () => {
    const teamName = 'create-team';
    const claudeDir = makeTeam(teamName);
    const taskCreate = collectTools().get('task_create')!;
    const request = {
      claudeDir,
      teamName,
      subject: 'Create exactly once',
      owner: 'lead',
      commandId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    };

    const [first, concurrentRetry] = await Promise.all([
      taskCreate.execute(request),
      taskCreate.execute(request),
    ]).then((results) => results.map(parseJsonToolResult));
    const duplicateRetry = parseJsonToolResult(await taskCreate.execute(request));

    expect(first.id).toBe(request.commandId);
    expect(first.creationCommand).toBeUndefined();
    expect(concurrentRetry.id).toBe(first.id);
    expect(duplicateRetry.id).toBe(first.id);
    expect(taskFiles(claudeDir, teamName)).toEqual([`${request.commandId}.json`]);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'tasks', teamName, `${request.commandId}.json`), 'utf8')
    ) as Record<string, unknown>;
    expect(persisted.creationCommand).toEqual(
      expect.objectContaining({
        namespace: 'agent-teams-mcp',
        scopeKey: teamName,
        commandId: request.commandId,
        payloadHash: expect.stringMatching(/^sha256:/),
      })
    );
  });

  it('replays from persisted provenance through a fresh tool boundary and rejects key reuse', async () => {
    const teamName = 'restart-team';
    const claudeDir = makeTeam(teamName);
    const request = {
      claudeDir,
      teamName,
      subject: 'Survive restart',
      idempotencyKey: 'restart-safe-create',
    };
    const beforeRestart = parseJsonToolResult(
      await collectTools().get('task_create')!.execute(request)
    );

    const afterRestartTools = collectTools();
    const replayed = parseJsonToolResult(
      await afterRestartTools.get('task_create')!.execute(request)
    );
    expect(replayed.id).toBe(beforeRestart.id);
    expect(taskFiles(claudeDir, teamName)).toHaveLength(1);

    await expect(
      afterRestartTools.get('task_create')!.execute({
        ...request,
        subject: 'Different payload with reused key',
      })
    ).rejects.toThrow('Task creation command conflict');
  });

  it('refuses to adopt an unrelated legacy task at a caller-selected command id', async () => {
    const teamName = 'legacy-collision-team';
    const claudeDir = makeTeam(teamName);
    const commandId = '22222222-2222-4222-8222-222222222222';
    const taskCreate = collectTools().get('task_create')!;

    parseJsonToolResult(
      await taskCreate.execute({
        claudeDir,
        teamName,
        subject: 'Original unrelated task',
        commandId,
      })
    );
    const taskPath = path.join(claudeDir, 'tasks', teamName, `${commandId}.json`);
    const legacyTask = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
    delete legacyTask.creationCommand;
    fs.writeFileSync(taskPath, JSON.stringify(legacyTask));

    await expect(
      taskCreate.execute({
        claudeDir,
        teamName,
        subject: 'Different requested task',
        commandId,
      })
    ).rejects.toThrow('is not owned by this command');

    const persisted = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
    expect(persisted.subject).toBe('Original unrelated task');
    expect(persisted.creationCommand).toBeUndefined();
  });

  it('keeps distinct request keys distinct even when the subject is identical', async () => {
    const teamName = 'same-subject-team';
    const claudeDir = makeTeam(teamName);
    fs.writeFileSync(
      path.join(claudeDir, 'teams', teamName, 'sentMessages.json'),
      JSON.stringify([
        {
          messageId: 'msg-user-1',
          from: 'user',
          to: 'lead',
          text: 'Review the same area twice',
          timestamp: '2026-07-22T12:00:00.000Z',
          source: 'user_sent',
        },
      ])
    );
    const taskCreateFromMessage = collectTools().get('task_create_from_message')!;
    const request = {
      claudeDir,
      teamName,
      messageId: 'msg-user-1',
      subject: 'Review the login flow',
      owner: 'lead',
    };

    const keyA = parseJsonToolResult(
      await taskCreateFromMessage.execute({ ...request, requestKey: 'key-a' })
    );
    const keyB = parseJsonToolResult(
      await taskCreateFromMessage.execute({ ...request, requestKey: 'key-b' })
    );

    // An explicit requestKey is the caller's intent, so an identical subject on the same
    // message must not fold two deliberately separate requests into one task.
    expect(keyB.id).not.toBe(keyA.id);
    expect(keyA.subject).toBe(keyB.subject);
    expect(taskFiles(claudeDir, teamName)).toHaveLength(2);

    const keyAReplay = parseJsonToolResult(
      await taskCreateFromMessage.execute({ ...request, requestKey: 'key-a' })
    );
    expect(keyAReplay.id).toBe(keyA.id);
    expect(taskFiles(claudeDir, teamName)).toHaveLength(2);

    // A keyless create carries no intent to separate, so the 10-minute content dedup
    // window still collapses a replay of it.
    const keylessRequest = { ...request, subject: 'Review the settings flow' };
    const keyless = parseJsonToolResult(await taskCreateFromMessage.execute(keylessRequest));
    const keylessReplay = parseJsonToolResult(await taskCreateFromMessage.execute(keylessRequest));
    expect(keylessReplay.id).toBe(keyless.id);
    expect(taskFiles(claudeDir, teamName)).toHaveLength(3);
  });

  it('uses messageId plus requestKey without collapsing distinct tasks from one message', async () => {
    const teamName = 'message-team';
    const claudeDir = makeTeam(teamName);
    const sentPath = path.join(claudeDir, 'teams', teamName, 'sentMessages.json');
    fs.writeFileSync(
      sentPath,
      JSON.stringify([
        {
          messageId: 'msg-user-1',
          from: 'user',
          to: 'lead',
          text: 'Please ship the UI and API changes',
          timestamp: '2026-07-22T12:00:00.000Z',
          source: 'user_sent',
        },
      ])
    );
    const taskCreateFromMessage = collectTools().get('task_create_from_message')!;
    const uiRequest = {
      claudeDir,
      teamName,
      messageId: 'msg-user-1',
      requestKey: 'ui-task',
      subject: 'Ship UI',
    };

    const [first, retry] = await Promise.all([
      taskCreateFromMessage.execute(uiRequest),
      taskCreateFromMessage.execute(uiRequest),
    ]).then((results) => results.map(parseJsonToolResult));
    const apiTask = parseJsonToolResult(
      await taskCreateFromMessage.execute({
        ...uiRequest,
        requestKey: 'api-task',
        subject: 'Ship API',
      })
    );

    expect(retry.id).toBe(first.id);
    expect(apiTask.id).not.toBe(first.id);
    expect(first.sourceMessageId).toBe('msg-user-1');
    expect(apiTask.sourceMessageId).toBe('msg-user-1');
    expect(taskFiles(claudeDir, teamName)).toHaveLength(2);

    await expect(
      taskCreateFromMessage.execute({
        ...uiRequest,
        subject: 'Changed payload with reused request key',
      })
    ).rejects.toThrow('Task creation command conflict');

    // An unkeyed call carries no command identity, so the message id alone must never
    // collapse two different task intents taken from the same message.
    const legacyDocs = parseJsonToolResult(
      await taskCreateFromMessage.execute({
        claudeDir,
        teamName,
        messageId: 'msg-user-1',
        subject: 'Legacy unkeyed docs task',
      })
    );
    const legacyTests = parseJsonToolResult(
      await taskCreateFromMessage.execute({
        claudeDir,
        teamName,
        messageId: 'msg-user-1',
        subject: 'Legacy unkeyed tests task',
      })
    );
    expect(legacyTests.id).not.toBe(legacyDocs.id);
    expect(taskFiles(claudeDir, teamName)).toHaveLength(4);

    // An unkeyed replay of the same intent is still collapsed, but by the task board's
    // content dedup (same owner/subject/createdBy within 10 minutes), which is the
    // authoritative duplicate signal for creates that carry no command identity.
    const legacyDocsReplay = parseJsonToolResult(
      await taskCreateFromMessage.execute({
        claudeDir,
        teamName,
        messageId: 'msg-user-1',
        subject: 'Legacy unkeyed docs task',
      })
    );
    expect(legacyDocsReplay.id).toBe(legacyDocs.id);
    expect(taskFiles(claudeDir, teamName)).toHaveLength(4);
  });
});
