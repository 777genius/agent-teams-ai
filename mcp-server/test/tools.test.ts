import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { registerTools } from '../src/tools';

type RegisteredTool = {
  name: string;
  parameters?: { safeParse: (value: unknown) => { success: boolean } };
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

function collectTools() {
  const tools = new Map<string, RegisteredTool>();

  registerTools({
    addTool(config: RegisteredTool) {
      tools.set(config.name, config);
    },
  } as never);

  return tools;
}

function parseJsonToolResult(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
  return JSON.parse(text);
}

describe('agent-teams-mcp tools', () => {
  const tools = collectTools();
  const expectedToolNames = [
    'cross_team_get_outbox',
    'cross_team_list_targets',
    'cross_team_send',
    'kanban_add_reviewer',
    'kanban_clear',
    'kanban_get',
    'kanban_list_reviewers',
    'kanban_remove_reviewer',
    'kanban_set_column',
    'member_briefing',
    'message_send',
    'process_list',
    'process_register',
    'process_stop',
    'process_unregister',
    'review_approve',
    'review_request',
    'review_request_changes',
    'task_add_comment',
    'task_attach_comment_file',
    'task_attach_file',
    'task_briefing',
    'task_complete',
    'task_create',
    'task_get',
    'task_link',
    'task_list',
    'task_set_clarification',
    'task_set_owner',
    'task_set_status',
    'task_start',
    'task_unlink',
    'team_launch',
    'team_stop',
  ] as const;

  function getTool(name: string) {
    const tool = tools.get(name);
    expect(tool).toBeDefined();
    return tool!;
  }

  function makeClaudeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-mcp-'));
  }

  function writeTeamConfig(
    claudeDir: string,
    teamName: string,
    config: {
      name?: string;
      language?: string;
      projectPath?: string;
      members: Array<Record<string, unknown>>;
    }
  ) {
    const teamDir = path.join(claudeDir, 'teams', teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify(
        {
          name: config.name ?? teamName,
          ...(config.language ? { language: config.language } : {}),
          ...(config.projectPath ? { projectPath: config.projectPath } : {}),
          members: config.members,
        },
        null,
        2
      )
    );
  }

  async function startControlServer(
    handler: (request: {
      method?: string;
      url?: string;
      body?: unknown;
    }) => Promise<{ statusCode?: number; body: unknown }> | { statusCode?: number; body: unknown }
  ) {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          const body = bodyText ? JSON.parse(bodyText) : undefined;
          const result = await handler({ method: req.method, url: req.url, body });
          res.writeHead(result.statusCode ?? 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result.body));
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind control server');
    }

    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: async () =>
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        ),
    };
  }

  it('registers the full expected MCP tool surface', () => {
    expect([...tools.keys()].sort()).toEqual([...expectedToolNames]);
  });

  it('accepts explicit conversation threading fields for cross_team_send', () => {
    const parsed = getTool('cross_team_send').parameters?.safeParse({
      teamName: 'alpha',
      toTeam: 'beta',
      text: 'Reply',
      conversationId: 'conv-1',
      replyToConversationId: 'conv-1',
    });

    expect(parsed?.success).toBe(true);
  });

  it('launches and stops teams through the runtime MCP tools', async () => {
    const calls: Array<{ method?: string; url?: string; body?: unknown }> = [];
    const server = await startControlServer(async ({ method, url, body }) => {
      calls.push({ method, url, body });

      if (method === 'POST' && url === '/api/teams/alpha/launch') {
        return { body: { runId: 'run-555' } };
      }
      if (method === 'GET' && url === '/api/teams/provisioning/run-555') {
        return {
          body: {
            runId: 'run-555',
            teamName: 'alpha',
            state: 'ready',
            message: 'Ready',
            startedAt: '2026-03-12T00:00:00.000Z',
            updatedAt: '2026-03-12T00:00:02.000Z',
          },
        };
      }
      if (method === 'POST' && url === '/api/teams/alpha/stop') {
        return {
          body: {
            teamName: 'alpha',
            isAlive: false,
            runId: null,
            progress: null,
          },
        };
      }
      if (method === 'GET' && url === '/api/teams/alpha/runtime') {
        return {
          body: {
            teamName: 'alpha',
            isAlive: false,
            runId: null,
            progress: null,
          },
        };
      }

      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });

    try {
      const launched = parseJsonToolResult(
        await getTool('team_launch').execute({
          teamName: 'alpha',
          cwd: '/tmp/project',
          controlUrl: server.baseUrl,
        })
      );
      expect(launched.runId).toBe('run-555');
      expect(launched.isAlive).toBe(true);
      expect(launched.progress.state).toBe('ready');

      const stopped = parseJsonToolResult(
        await getTool('team_stop').execute({
          teamName: 'alpha',
          controlUrl: server.baseUrl,
        })
      );
      expect(stopped.isAlive).toBe(false);

      expect(calls).toEqual([
        {
          method: 'POST',
          url: '/api/teams/alpha/launch',
          body: { cwd: '/tmp/project' },
        },
        {
          method: 'GET',
          url: '/api/teams/provisioning/run-555',
          body: undefined,
        },
        {
          method: 'POST',
          url: '/api/teams/alpha/stop',
          body: undefined,
        },
        {
          method: 'GET',
          url: '/api/teams/alpha/runtime',
          body: undefined,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('discovers the control endpoint from the published state file', async () => {
    const claudeDir = makeClaudeDir();
    const statePath = path.join(claudeDir, 'team-control-api.json');

    const server = await startControlServer(async ({ method, url }) => {
      if (method === 'POST' && url === '/api/teams/alpha/launch') {
        return { body: { runId: 'run-state-file' } };
      }
      if (method === 'GET' && url === '/api/teams/provisioning/run-state-file') {
        return {
          body: {
            runId: 'run-state-file',
            teamName: 'alpha',
            state: 'ready',
            message: 'Ready',
            startedAt: '2026-03-12T00:00:00.000Z',
            updatedAt: '2026-03-12T00:00:02.000Z',
          },
        };
      }
      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });

    try {
      fs.writeFileSync(
        statePath,
        JSON.stringify({ baseUrl: server.baseUrl, updatedAt: new Date().toISOString() }, null, 2)
      );

      const launched = parseJsonToolResult(
        await getTool('team_launch').execute({
          teamName: 'alpha',
          claudeDir,
          cwd: '/tmp/project',
        })
      );

      expect(launched.runId).toBe('run-state-file');
      expect(launched.progress.state).toBe('ready');
    } finally {
      await server.close();
    }
  });

  it('covers task lifecycle, attachments, relationships, kanban, and review flows', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'alpha';
    writeTeamConfig(claudeDir, teamName, {
      language: 'en',
      members: [
        { name: 'lead', role: 'team-lead' },
        { name: 'alice', role: 'developer' },
      ],
    });
    const attachmentPath = path.join(claudeDir, 'note.txt');
    fs.writeFileSync(attachmentPath, 'ship it');

    const dependencyTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Dependency',
      })
    );

    const createdTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Review MCP adapter',
        owner: 'alice',
        createdBy: 'ui-fixer',
      })
    );
    expect(createdTask.status).toBe('pending');
    expect(createdTask.historyEvents?.[0]?.actor).toBe('ui-fixer');

    const listedTasks = parseJsonToolResult(
      await getTool('task_list').execute({
        claudeDir,
        teamName,
      })
    );
    expect(listedTasks).toHaveLength(2);

    const linked = parseJsonToolResult(
      await getTool('task_link').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        targetId: dependencyTask.id,
        relationship: 'blocked-by',
      })
    );
    expect(linked.blockedBy).toContain(dependencyTask.id);

    const unlinked = parseJsonToolResult(
      await getTool('task_unlink').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        targetId: dependencyTask.id,
        relationship: 'blocked-by',
      })
    );
    expect(unlinked.blockedBy ?? []).not.toContain(dependencyTask.id);

    const owned = parseJsonToolResult(
      await getTool('task_set_owner').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        owner: 'alice',
      })
    );
    expect(owned.owner).toBe('alice');

    const commented = parseJsonToolResult(
      await getTool('task_add_comment').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        text: 'Need one more check',
        from: 'lead',
      })
    );

    const commentId = commented.commentId;
    expect(commentId).toBeTruthy();

    const ownerInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
    const ownerInbox = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(ownerInbox.at(-1).summary).toContain(`#${createdTask.displayId}`);
    expect(ownerInbox.at(-1).text).toContain('Need one more check');

    const attachment = parseJsonToolResult(
      await getTool('task_attach_comment_file').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        commentId,
        filePath: attachmentPath,
        mode: 'copy',
      })
    );

    expect(attachment.filename).toBe('note.txt');

    const taskAttachment = parseJsonToolResult(
      await getTool('task_attach_file').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        filePath: attachmentPath,
        mode: 'copy',
      })
    );
    expect(taskAttachment.filename).toBe('note.txt');

    await getTool('task_set_clarification').execute({
      claudeDir,
      teamName,
      taskId: createdTask.id,
      value: 'user',
    });

    const loadedTask = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
      })
    );

    expect(loadedTask.needsClarification).toBe('user');
    expect(loadedTask.comments).toHaveLength(1);
    expect(loadedTask.comments[0].attachments).toHaveLength(1);
    expect(loadedTask.attachments).toHaveLength(1);

    const started = parseJsonToolResult(
      await getTool('task_start').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        actor: 'alice',
      })
    );
    expect(started.status).toBe('in_progress');

    await getTool('task_set_status').execute({
      claudeDir,
      teamName,
      taskId: createdTask.id,
      status: 'completed',
    });

    parseJsonToolResult(
      await getTool('kanban_add_reviewer').execute({
        claudeDir,
        teamName,
        reviewer: 'alice',
      })
    );
    const reviewers = parseJsonToolResult(
      await getTool('kanban_list_reviewers').execute({
        claudeDir,
        teamName,
      })
    );
    expect(reviewers).toEqual(['alice']);

    const reviewRequested = parseJsonToolResult(
      await getTool('review_request').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        from: 'lead',
        reviewer: 'alice',
        leadSessionId: 'session-review-1',
      })
    );

    expect(reviewRequested.reviewState).toBe('review');
    const reviewerInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
    const reviewerInbox = JSON.parse(fs.readFileSync(reviewerInboxPath, 'utf8'));
    expect(reviewerInbox.at(-1).leadSessionId).toBe('session-review-1');

    const approved = parseJsonToolResult(
      await getTool('review_approve').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        from: 'lead',
        note: 'Looks good',
        notifyOwner: true,
        leadSessionId: 'session-review-1',
      })
    );
    expect(approved.reviewState).toBe('approved');
    {
      const approvedInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
      const approvedInbox = JSON.parse(fs.readFileSync(approvedInboxPath, 'utf8'));
      expect(approvedInbox.at(-1).leadSessionId).toBe('session-review-1');
    }

    const kanbanState = parseJsonToolResult(
      await getTool('kanban_get').execute({
        claudeDir,
        teamName,
      })
    );
    expect(kanbanState.tasks[createdTask.id].column).toBe('approved');

    const briefing = await getTool('task_briefing').execute({
      claudeDir,
      teamName,
      memberName: 'alice',
    });
    expect((briefing as { content: Array<{ text: string }> }).content[0]?.text).toContain(
      'Review MCP adapter'
    );

    const memberBriefing = await getTool('member_briefing').execute({
      claudeDir,
      teamName,
      memberName: 'alice',
    });
    const memberBriefingText = (memberBriefing as { content: Array<{ text: string }> }).content[0]
      ?.text;
    expect(memberBriefingText).toContain('Member briefing for alice on team "alpha" (alpha).');
    expect(memberBriefingText).toContain('Use task_briefing as your compact queue view');
    expect(memberBriefingText).toContain('Review MCP adapter');
  });

  it('keeps owner-backed MCP tasks pending by default, supports explicit startImmediately, sends owner notifications, and returns compact task_briefing output', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'gamma';
    writeTeamConfig(claudeDir, teamName, {
      language: 'en',
      projectPath: '/tmp/gamma-project',
      members: [
        { name: 'lead', role: 'team-lead' },
        { name: 'alice', role: 'developer', workflow: 'Stay focused' },
      ],
    });

    const queuedTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Queued work',
        description: 'Pending description should stay out of briefing details',
        owner: 'alice',
        prompt: 'Read the plan before starting.',
      })
    );
    expect(queuedTask.status).toBe('pending');

    const activeTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Active work',
        description: 'This one is already in progress',
        owner: 'alice',
        startImmediately: true,
      })
    );
    expect(activeTask.status).toBe('in_progress');

    await getTool('task_add_comment').execute({
      claudeDir,
      teamName,
      taskId: activeTask.id,
      text: 'Investigating the active task now.',
      from: 'alice',
    });

    const completedTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Done work',
        description: 'Completed description should also stay compact',
        owner: 'alice',
      })
    );
    await getTool('task_complete').execute({
      claudeDir,
      teamName,
      taskId: completedTask.id,
      actor: 'alice',
    });

    const unassignedTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Assign later',
      })
    );
    await getTool('task_set_owner').execute({
      claudeDir,
      teamName,
      taskId: unassignedTask.id,
      owner: 'alice',
    });

    const queuedByHashRef = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: `#${queuedTask.displayId}`,
      })
    );
    expect(queuedByHashRef.id).toBe(queuedTask.id);

    const ownerInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
    const ownerInbox = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(ownerInbox).toHaveLength(4);
    expect(ownerInbox[0].summary).toContain(`#${queuedTask.displayId}`);
    expect(ownerInbox[0].text).toContain('task_get');
    expect(ownerInbox[0].text).toContain('task_start');
    expect(ownerInbox[0].text).toContain('task_add_comment');
    expect(ownerInbox[0].text).toContain('Read the plan before starting.');
    expect(ownerInbox[0].text).toContain('If you are idle and this task is ready to start, start it now.');
    expect(ownerInbox[0].text).toContain(
      'If you are busy, blocked, or still need more context, immediately add a short task comment'
    );
    expect(ownerInbox[3].summary).toContain(`#${unassignedTask.displayId}`);
    expect(ownerInbox[3].text).toContain('If you are idle and this task is ready to start, start it now.');
    expect(ownerInbox[3].text).toContain('task_add_comment');

    const briefing = (await getTool('task_briefing').execute({
      claudeDir,
      teamName,
      memberName: 'alice',
    })) as { content: Array<{ text: string }> };
    const briefingText = briefing.content[0]?.text ?? '';
    expect(briefingText).toContain('In progress:');
    expect(briefingText).toContain(`#${activeTask.displayId}`);
    expect(briefingText).toContain('Description: This one is already in progress');
    expect(briefingText).toContain('Investigating the active task now.');
    expect(briefingText).toContain('Pending:');
    expect(briefingText).toContain(`#${queuedTask.displayId}`);
    expect(briefingText).not.toContain('Pending description should stay out of briefing details');
    expect(briefingText).toContain('Completed:');
    expect(briefingText).toContain(`#${completedTask.displayId}`);
    expect(briefingText).not.toContain('Completed description should also stay compact');

    const memberBriefing = (await getTool('member_briefing').execute({
      claudeDir,
      teamName,
      memberName: 'alice',
    })) as { content: Array<{ text: string }> };
    const memberBriefingText = memberBriefing.content[0]?.text ?? '';
    expect(memberBriefingText).toContain(
      'You must NOT start work, claim tasks, or improvise task/process protocol'
    );
    expect(memberBriefingText).toContain(
      'A newly assigned task must NOT remain silently pending/TODO. If you are idle and the task is ready to start, start it now.'
    );
    expect(memberBriefingText).toContain('reason and your best ETA or what you are waiting on');
    expect(memberBriefingText).toContain('IMPORTANT: Communicate in English.');
    expect(memberBriefingText).toContain('TURN ACTION MODE PROTOCOL (HIGHEST PRIORITY FOR EACH USER TURN):');
    expect(memberBriefingText).toContain('Task briefing for alice:');
    expect(memberBriefingText).toContain(`#${activeTask.displayId}`);

    fs.mkdirSync(path.join(claudeDir, 'teams', teamName, 'inboxes'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'carol.json'), '[]');
    fs.writeFileSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'cross_team_send.json'), '[]');
    fs.writeFileSync(path.join(claudeDir, 'teams', teamName, 'inboxes', 'other-team.alice.json'), '[]');

    const inboxResolvedBriefing = (await getTool('member_briefing').execute({
      claudeDir,
      teamName,
      memberName: 'carol',
    })) as { content: Array<{ text: string }> };
    const inboxResolvedBriefingText = inboxResolvedBriefing.content[0]?.text ?? '';
    expect(inboxResolvedBriefingText).toContain('Member briefing for carol on team "gamma" (gamma).');
    expect(inboxResolvedBriefingText).toContain('Role: team member.');

    await expect(
      getTool('member_briefing').execute({
        claudeDir,
        teamName,
        memberName: 'dave',
      })
    ).rejects.toThrow('Member not found in team metadata or inboxes: dave');
    await expect(
      getTool('member_briefing').execute({
        claudeDir,
        teamName,
        memberName: 'cross_team_send',
      })
    ).rejects.toThrow('Member not found in team metadata or inboxes: cross_team_send');
    await expect(
      getTool('member_briefing').execute({
        claudeDir,
        teamName,
        memberName: 'other-team.alice',
      })
    ).rejects.toThrow('Member not found in team metadata or inboxes: other-team.alice');
    expect(inboxResolvedBriefingText).not.toContain(
      'Warning: Member metadata was not found in config.json, members.meta.json, or inbox files yet.'
    );
  });

  it('covers review_request_changes and full process lifecycle tools', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'beta';

    const createdTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Needs revision',
        owner: 'bob',
      })
    );

    await getTool('task_complete').execute({
      claudeDir,
      teamName,
      taskId: createdTask.id,
      actor: 'bob',
    });

    await getTool('review_request').execute({
      claudeDir,
      teamName,
      taskId: createdTask.id,
      from: 'lead',
      reviewer: 'alice',
      leadSessionId: 'session-review-2',
    });

    const changesRequested = parseJsonToolResult(
      await getTool('review_request_changes').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
        from: 'alice',
        comment: 'Please revise this section.',
        leadSessionId: 'session-review-2',
      })
    );

    expect(changesRequested.status).toBe('pending');
    expect(changesRequested.reviewState).toBe('needsFix');
    const ownerInboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'bob.json');
    const ownerInbox = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(ownerInbox.at(-1).leadSessionId).toBe('session-review-2');
    expect(ownerInbox.at(-1).text).toContain('moved back to pending');

    const taskByHashRef = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: `#${createdTask.displayId}`,
      })
    );
    expect(taskByHashRef.reviewState).toBe('needsFix');

    const listedTasks = parseJsonToolResult(
      await getTool('task_list').execute({
        claudeDir,
        teamName,
      })
    );
    expect(listedTasks.find((task: { id: string }) => task.id === createdTask.id)?.reviewState).toBe(
      'needsFix'
    );

    const kanbanCleared = parseJsonToolResult(
      await getTool('kanban_clear').execute({
        claudeDir,
        teamName,
        taskId: createdTask.id,
      })
    );
    expect(kanbanCleared.tasks[createdTask.id]).toBeUndefined();

    const pid = process.pid;

    const registered = parseJsonToolResult(
      await getTool('process_register').execute({
        claudeDir,
        teamName,
        pid,
        label: 'vite',
        command: 'pnpm dev',
        from: 'lead',
        port: 3000,
      })
    );

    expect(registered.pid).toBe(pid);
    expect(registered.label).toBe('vite');

    const listed = parseJsonToolResult(
      await getTool('process_list').execute({
        claudeDir,
        teamName,
      })
    );

    expect(listed).toHaveLength(1);
    expect(listed[0].pid).toBe(pid);

    const stopped = parseJsonToolResult(
      await getTool('process_stop').execute({
        claudeDir,
        teamName,
        pid,
      })
    );

    expect(stopped.pid).toBe(pid);
    expect(typeof stopped.stoppedAt).toBe('string');

    const unregistered = parseJsonToolResult(
      await getTool('process_unregister').execute({
        claudeDir,
        teamName,
        pid,
      })
    );
    expect(unregistered).toEqual([]);
  });

  it('persists full message metadata through message_send', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'gamma';

    const sent = parseJsonToolResult(
      await getTool('message_send').execute({
        claudeDir,
        teamName,
        to: 'alice',
        text: 'Check this',
        from: 'lead',
        summary: 'Metadata test',
        source: 'system_notification',
        leadSessionId: 'session-42',
        attachments: [{ id: 'att-1', filename: 'note.txt', mimeType: 'text/plain', size: 4 }],
      })
    );

    expect(sent.deliveredToInbox).toBe(true);
    const inboxPath = path.join(claudeDir, 'teams', teamName, 'inboxes', 'alice.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows[0].source).toBe('system_notification');
    expect(rows[0].leadSessionId).toBe('session-42');
    expect(rows[0].attachments[0].filename).toBe('note.txt');
  });

  it('exposes zod schemas that reject obviously invalid payloads', () => {
    expect(
      getTool('task_create').parameters?.safeParse({
        teamName: 'demo',
        claudeDir: '/tmp/demo',
      }).success
    ).toBe(false);

    expect(
      getTool('task_create').parameters?.safeParse({
        teamName: 'demo',
        claudeDir: '/tmp/demo',
        subject: 'Created by schema',
        createdBy: 'ui-fixer',
      }).success
    ).toBe(true);

    expect(
      getTool('process_register').parameters?.safeParse({
        teamName: 'demo',
        pid: 0,
        label: '',
      }).success
    ).toBe(false);
  });

  it('task_add_comment succeeds even when owner inbox write fails', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'resilience';

    const task = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Comment resilience test',
        owner: 'alice',
        notifyOwner: false,
      })
    );

    // Corrupt the inbox file to force notification failure
    const inboxDir = path.join(claudeDir, 'teams', teamName, 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'alice.json'), 'BROKEN JSON');

    const commented = parseJsonToolResult(
      await getTool('task_add_comment').execute({
        claudeDir,
        teamName,
        taskId: task.id,
        text: 'Comment should persist despite broken inbox',
        from: 'bob',
      })
    );

    expect(commented.commentId).toBeTruthy();

    // Verify the comment is actually persisted on the task
    const reloaded = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: task.id,
      })
    );

    expect(reloaded.comments).toHaveLength(1);
    expect(reloaded.comments[0].text).toBe('Comment should persist despite broken inbox');
  });
});
