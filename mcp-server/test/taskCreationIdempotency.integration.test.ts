import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

    const legacyFirst = parseJsonToolResult(
      await taskCreateFromMessage.execute({
        claudeDir,
        teamName,
        messageId: 'msg-user-1',
        subject: 'Legacy unkeyed task',
      })
    );
    const legacySecond = parseJsonToolResult(
      await taskCreateFromMessage.execute({
        claudeDir,
        teamName,
        messageId: 'msg-user-1',
        subject: 'Legacy unkeyed task',
      })
    );
    expect(legacySecond.id).not.toBe(legacyFirst.id);
  });
});
