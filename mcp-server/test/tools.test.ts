import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { AGENT_TEAMS_REGISTERED_TOOL_NAMES, registerTools } from '../src/tools';

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
    expect([...tools.keys()].sort()).toEqual([...AGENT_TEAMS_REGISTERED_TOOL_NAMES].sort());
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
    writeTeamConfig(claudeDir, teamName, {
      members: [
        { name: 'lead', role: 'team-lead' },
        { name: 'alice', role: 'reviewer' },
        { name: 'bob', role: 'developer' },
      ],
    });

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

    // review_start: moves task to review without requiring completed status
    const pendingTask = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Start review test',
        owner: 'bob',
      })
    );
    const reviewStarted = parseJsonToolResult(
      await getTool('review_start').execute({
        claudeDir,
        teamName,
        taskId: pendingTask.id,
        from: 'alice',
      })
    );
    expect(reviewStarted.ok).toBe(true);
    expect(reviewStarted.column).toBe('review');
    expect(reviewStarted.taskId).toBe(pendingTask.id);

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
    writeTeamConfig(claudeDir, teamName, {
      members: [
        { name: 'lead', role: 'team-lead' },
        { name: 'alice', role: 'developer' },
      ],
    });

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

  it('write operations return slim task (no comments/historyEvents arrays)', async () => {
    const claudeDir = makeClaudeDir();
    const teamName = 'slim-check';

    fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
    writeTeamConfig(claudeDir, teamName, { members: [{ name: 'lead' }] });

    const task = parseJsonToolResult(
      await getTool('task_create').execute({
        claudeDir,
        teamName,
        subject: 'Slim task test',
        owner: 'lead',
        notifyOwner: false,
      })
    );

    // task_create returns full task (read operation)
    expect(task.historyEvents).toBeDefined();

    // Add a comment so commentCount > 0
    const commented = parseJsonToolResult(
      await getTool('task_add_comment').execute({
        claudeDir,
        teamName,
        taskId: task.id,
        text: 'test comment',
        from: 'lead',
      })
    );

    // task_add_comment: nested task should be slim
    expect(commented.commentId).toBeTruthy();
    expect(commented.comment.text).toBe('test comment');
    expect(commented.task.commentCount).toBe(1);
    expect(commented.task.comments).toBeUndefined();
    expect(commented.task.historyEvents).toBeUndefined();

    // task_start: returns slim task directly
    const started = parseJsonToolResult(
      await getTool('task_start').execute({
        claudeDir,
        teamName,
        taskId: task.id,
        actor: 'lead',
      })
    );
    expect(started.status).toBe('in_progress');
    expect(started.commentCount).toBe(1);
    expect(started.comments).toBeUndefined();
    expect(started.historyEvents).toBeUndefined();
    expect(started.workIntervals).toBeUndefined();

    // task_complete: returns slim task directly
    const completed = parseJsonToolResult(
      await getTool('task_complete').execute({
        claudeDir,
        teamName,
        taskId: task.id,
        actor: 'lead',
      })
    );
    expect(completed.status).toBe('completed');
    expect(completed.comments).toBeUndefined();

    // task_list: uses blocklist, includes description but not comments array
    const listed = parseJsonToolResult(
      await getTool('task_list').execute({ claudeDir, teamName })
    );
    const listedTask = listed.find((t: { id: string }) => t.id === task.id);
    expect(listedTask).toBeDefined();
    expect(listedTask.subject).toBe('Slim task test');
    expect(listedTask.commentCount).toBe(1);
    expect(listedTask.comments).toBeUndefined();
    expect(listedTask.historyEvents).toBeUndefined();
    expect(listedTask.workIntervals).toBeUndefined();
    // task_list preserves non-heavy fields
    expect(listedTask.status).toBeDefined();
    expect(listedTask.id).toBeDefined();

    // task_get: still returns full task with comments
    const full = parseJsonToolResult(
      await getTool('task_get').execute({
        claudeDir,
        teamName,
        taskId: task.id,
      })
    );
    expect(full.comments).toHaveLength(1);
    expect(full.historyEvents).toBeDefined();
  });

  describe('task_create_from_message', () => {
    function writeSentMessage(
      claudeDir: string,
      teamName: string,
      message: Record<string, unknown>
    ) {
      const sentPath = path.join(claudeDir, 'teams', teamName, 'sentMessages.json');
      const teamDir = path.join(claudeDir, 'teams', teamName);
      fs.mkdirSync(teamDir, { recursive: true });
      const existing = fs.existsSync(sentPath)
        ? JSON.parse(fs.readFileSync(sentPath, 'utf8'))
        : [];
      existing.push(message);
      fs.writeFileSync(sentPath, JSON.stringify(existing, null, 2));
    }

    function writeInboxMessage(
      claudeDir: string,
      teamName: string,
      memberName: string,
      message: Record<string, unknown>
    ) {
      const inboxDir = path.join(claudeDir, 'teams', teamName, 'inboxes');
      fs.mkdirSync(inboxDir, { recursive: true });
      const inboxPath = path.join(inboxDir, `${memberName}.json`);
      const existing = fs.existsSync(inboxPath)
        ? JSON.parse(fs.readFileSync(inboxPath, 'utf8'))
        : [];
      existing.push(message);
      fs.writeFileSync(inboxPath, JSON.stringify(existing, null, 2));
    }

    it('creates a task from a valid user message with provenance', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'msg-team';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      const messageId = 'msg-user-001';
      writeSentMessage(claudeDir, teamName, {
        messageId,
        from: 'user',
        to: 'team-lead',
        text: 'Please implement the login page',
        timestamp: '2026-03-15T10:00:00.000Z',
        source: 'user_sent',
      });

      const created = parseJsonToolResult(
        await getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId,
          subject: 'Implement login page',
          owner: 'lead',
        })
      );

      expect(created.subject).toBe('Implement login page');
      expect(created.owner).toBe('lead');
      expect(created.sourceMessageId).toBe(messageId);
      expect(created.sourceMessage).toBeDefined();
      expect(created.sourceMessage.text).toBe('Please implement the login page');
      expect(created.sourceMessage.from).toBe('user');
      expect(created.sourceMessage.timestamp).toBe('2026-03-15T10:00:00.000Z');
      expect(created.sourceMessage.source).toBe('user_sent');
    });

    it('strips agent-only blocks from source text', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'strip-team';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      const messageId = 'msg-with-agent-blocks';
      writeSentMessage(claudeDir, teamName, {
        messageId,
        from: 'user',
        text: 'Fix the bug <info_for_agent>\nuse task_create to track\n</info_for_agent> in the API',
        timestamp: '2026-03-15T11:00:00.000Z',
        source: 'user_sent',
      });

      const created = parseJsonToolResult(
        await getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId,
          subject: 'Fix API bug',
        })
      );

      expect(created.sourceMessage.text).toBe('Fix the bug  in the API');
      expect(created.sourceMessage.text).not.toContain('info_for_agent');
    });

    it('rejects unknown messageId', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'unknown-msg';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      await expect(
        getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId: 'nonexistent-msg',
          subject: 'Should fail',
        })
      ).rejects.toThrow(
        'Message not found: nonexistent-msg. task_create_from_message only works with the explicit User MessageId'
      );
    });

    it('rejects non-user-originated message sources', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'source-reject';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      const messageId = 'msg-system-001';
      writeSentMessage(claudeDir, teamName, {
        messageId,
        from: 'system',
        text: 'System generated notification',
        timestamp: '2026-03-15T12:00:00.000Z',
        source: 'system_notification',
      });

      await expect(
        getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId,
          subject: 'Should fail',
        })
      ).rejects.toThrow(
        'task_create_from_message only accepts explicit user_sent messages from the relay prompt'
      );
    });

    it('rejects lead_process and cross_team sources explicitly', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'source-reject-2';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      writeSentMessage(claudeDir, teamName, {
        messageId: 'msg-lead-001',
        from: 'team-lead',
        text: 'Lead process message',
        timestamp: '2026-03-15T12:01:00.000Z',
        source: 'lead_process',
      });

      writeSentMessage(claudeDir, teamName, {
        messageId: 'msg-cross-001',
        from: 'other-team.lead',
        text: 'Cross team message',
        timestamp: '2026-03-15T12:02:00.000Z',
        source: 'cross_team',
      });

      await expect(
        getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId: 'msg-lead-001',
          subject: 'Should fail',
        })
      ).rejects.toThrow(
        'task_create_from_message only accepts explicit user_sent messages from the relay prompt'
      );

      await expect(
        getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId: 'msg-cross-001',
          subject: 'Should fail',
        })
      ).rejects.toThrow(
        'task_create_from_message only accepts explicit user_sent messages from the relay prompt'
      );
    });

    it('rejects messages without an explicit source field (fail closed)', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'no-source';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      writeSentMessage(claudeDir, teamName, {
        messageId: 'msg-no-source',
        from: 'user',
        text: 'Old message without source field',
        timestamp: '2026-03-15T12:03:00.000Z',
        // no source field
      });

      await expect(
        getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId: 'msg-no-source',
          subject: 'Should fail',
        })
      ).rejects.toThrow(
        'task_create_from_message only accepts explicit user_sent messages from the relay prompt'
      );
    });

    it('rejects relay copies', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'relay-reject';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      const messageId = 'msg-relay-001';
      writeSentMessage(claudeDir, teamName, {
        messageId,
        from: 'user',
        text: 'Relayed content',
        timestamp: '2026-03-15T13:00:00.000Z',
        source: 'user_sent',
        relayOfMessageId: 'original-msg-999',
      });

      await expect(
        getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId,
          subject: 'Should fail',
        })
      ).rejects.toThrow(
        'Cannot create task from a relay copy. Use the original user_sent message and its explicit User MessageId from the relay prompt instead.'
      );
    });

    it('preserves attachment metadata without blob copying', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'attach-meta';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      const messageId = 'msg-attach-001';
      writeInboxMessage(claudeDir, teamName, 'lead', {
        messageId,
        from: 'user',
        to: 'lead',
        text: 'See attached screenshot',
        timestamp: '2026-03-15T14:00:00.000Z',
        source: 'user_sent',
        attachments: [
          { id: 'att-1', filename: 'screenshot.png', mimeType: 'image/png', size: 42000 },
        ],
      });

      const created = parseJsonToolResult(
        await getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId,
          subject: 'Review screenshot',
        })
      );

      expect(created.sourceMessage.attachments).toHaveLength(1);
      expect(created.sourceMessage.attachments[0].id).toBe('att-1');
      expect(created.sourceMessage.attachments[0].filename).toBe('screenshot.png');
      expect(created.sourceMessage.attachments[0].mimeType).toBe('image/png');
      expect(created.sourceMessage.attachments[0].size).toBe(42000);
    });

    it('produces the same canonical task shape as task_create plus provenance', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'parity-check';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      const messageId = 'msg-parity-001';
      writeSentMessage(claudeDir, teamName, {
        messageId,
        from: 'user',
        text: 'Build the dashboard',
        timestamp: '2026-03-15T15:00:00.000Z',
        source: 'user_sent',
      });

      const fromMessage = parseJsonToolResult(
        await getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId,
          subject: 'Build dashboard',
          description: 'Create the main dashboard view',
          owner: 'lead',
        })
      );

      const regular = parseJsonToolResult(
        await getTool('task_create').execute({
          claudeDir,
          teamName,
          subject: 'Build dashboard (regular)',
          description: 'Create the main dashboard view',
          owner: 'lead',
        })
      );

      // Both have the same canonical shape
      expect(fromMessage.status).toBe(regular.status);
      expect(fromMessage.historyEvents).toHaveLength(regular.historyEvents.length);
      expect(typeof fromMessage.id).toBe(typeof regular.id);
      expect(typeof fromMessage.displayId).toBe(typeof regular.displayId);

      // Only the from_message task has provenance
      expect(fromMessage.sourceMessageId).toBe(messageId);
      expect(fromMessage.sourceMessage).toBeDefined();
      expect(regular.sourceMessageId).toBeUndefined();
      expect(regular.sourceMessage).toBeUndefined();
    });

    it('survives create → persist → read round-trip with provenance intact', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'roundtrip';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      const messageId = 'msg-roundtrip-001';
      writeSentMessage(claudeDir, teamName, {
        messageId,
        from: 'user',
        text: 'Roundtrip test message',
        timestamp: '2026-03-15T16:00:00.000Z',
        source: 'user_sent',
        attachments: [
          { id: 'att-rt', filename: 'data.csv', mimeType: 'text/csv', size: 1024 },
        ],
      });

      const created = parseJsonToolResult(
        await getTool('task_create_from_message').execute({
          claudeDir,
          teamName,
          messageId,
          subject: 'Roundtrip task',
          description: 'Test persistence',
        })
      );

      // Re-read from disk via task_get to verify persistence
      const reloaded = parseJsonToolResult(
        await getTool('task_get').execute({
          claudeDir,
          teamName,
          taskId: created.id,
        })
      );

      expect(reloaded.sourceMessageId).toBe(messageId);
      expect(reloaded.sourceMessage).toBeDefined();
      expect(reloaded.sourceMessage.text).toBe('Roundtrip test message');
      expect(reloaded.sourceMessage.from).toBe('user');
      expect(reloaded.sourceMessage.timestamp).toBe('2026-03-15T16:00:00.000Z');
      expect(reloaded.sourceMessage.source).toBe('user_sent');
      expect(reloaded.sourceMessage.attachments).toHaveLength(1);
      expect(reloaded.sourceMessage.attachments[0].id).toBe('att-rt');
    });

    it('old tasks without provenance continue to read normally', async () => {
      const claudeDir = makeClaudeDir();
      const teamName = 'legacy';
      fs.mkdirSync(path.join(claudeDir, 'tasks', teamName), { recursive: true });
      writeTeamConfig(claudeDir, teamName, {
        members: [{ name: 'lead', role: 'team-lead' }],
      });

      // Create a regular task (no provenance)
      const regular = parseJsonToolResult(
        await getTool('task_create').execute({
          claudeDir,
          teamName,
          subject: 'Legacy task without provenance',
        })
      );

      // Re-read — should work without provenance fields
      const reloaded = parseJsonToolResult(
        await getTool('task_get').execute({
          claudeDir,
          teamName,
          taskId: regular.id,
        })
      );

      expect(reloaded.subject).toBe('Legacy task without provenance');
      expect(reloaded.sourceMessageId).toBeUndefined();
      expect(reloaded.sourceMessage).toBeUndefined();
    });

    it('validates zod schema rejects missing required fields', () => {
      expect(
        getTool('task_create_from_message').parameters?.safeParse({
          teamName: 'demo',
          messageId: 'msg-1',
          // subject is missing
        }).success
      ).toBe(false);

      expect(
        getTool('task_create_from_message').parameters?.safeParse({
          teamName: 'demo',
          // messageId is missing
          subject: 'Test',
        }).success
      ).toBe(false);

      expect(
        getTool('task_create_from_message').parameters?.safeParse({
          teamName: 'demo',
          messageId: 'msg-1',
          subject: 'Valid',
        }).success
      ).toBe(true);
    });
  });

  it('fails closed for task_create when team config does not exist', async () => {
    const claudeDir = makeClaudeDir();

    await expect(
      getTool('task_create').execute({
        claudeDir,
        teamName: 'team-lead',
        subject: 'Phantom task should fail',
      })
    ).rejects.toThrow(
      'Unknown team "team-lead". Board tools require an existing configured team with config.json.'
    );
  });

  it('fails closed for task_create_from_message when team config does not exist', async () => {
    const claudeDir = makeClaudeDir();

    await expect(
      getTool('task_create_from_message').execute({
        claudeDir,
        teamName: 'team-lead',
        messageId: 'msg-1',
        subject: 'Phantom task should fail',
      })
    ).rejects.toThrow(
      'Unknown team "team-lead". Board tools require an existing configured team with config.json.'
    );
  });
});
