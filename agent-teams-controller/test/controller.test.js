const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

describe('agent-teams-controller API', () => {
  function makeClaudeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-controller-'));
    fs.mkdirSync(path.join(dir, 'teams', 'my-team'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tasks', 'my-team'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'teams', 'my-team', 'config.json'),
      JSON.stringify(
        {
          name: 'my-team',
          leadSessionId: 'lead-session-1',
          members: [
            { name: 'alice', role: 'team-lead' },
            { name: 'bob', role: 'developer' },
          ],
        },
        null,
        2
      )
    );
    return dir;
  }

  async function startControlServer(handler) {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          const body = bodyText ? JSON.parse(bodyText) : undefined;
          const result = await handler({
            method: req.method,
            url: req.url,
            body,
          });
          res.writeHead(result.statusCode || 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result.body));
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: async () => await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
  }

  function writeControlApiState(claudeDir, baseUrl) {
    fs.writeFileSync(
      path.join(claudeDir, 'team-control-api.json'),
      JSON.stringify({ baseUrl, updatedAt: new Date().toISOString() }, null, 2)
    );
  }

  it('creates tasks and exposes grouped controller modules', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const base = controller.tasks.createTask({ subject: 'Base task' });
    const dependency = controller.tasks.createTask({ subject: 'Dependency task' });
    const created = controller.tasks.createTask({
      subject: 'Blocked task',
      owner: 'bob',
      'blocked-by': `${base.displayId},${dependency.displayId}`,
      related: base.displayId,
    });

    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(created.displayId).toHaveLength(8);
    expect(created.status).toBe('pending');
    expect(created.reviewState).toBe('none');
    expect(controller.tasks.getTask(base.id).blocks).toEqual([created.id]);
    expect(controller.tasks.getTask(created.displayId).blockedBy).toEqual([base.id, dependency.id]);

    controller.kanban.addReviewer('alice');
    controller.tasks.completeTask(created.id, 'bob');
    controller.review.requestReview(created.id, { from: 'alice' });
    controller.review.approveReview(created.id, { 'notify-owner': true, from: 'alice' });

    const kanbanState = controller.kanban.getKanbanState();
    expect(kanbanState.reviewers).toEqual(['alice']);
    expect(kanbanState.tasks[created.id].column).toBe('approved');
    expect(controller.tasks.getTask(created.id).reviewState).toBe('approved');

    const sent = controller.messages.appendSentMessage({
      from: 'team-lead',
      to: 'user',
      text: 'All good',
      leadSessionId: 'session-1',
      source: 'lead_process',
      attachments: [{ id: 'a1', filename: 'diff.txt', mimeType: 'text/plain', size: 12 }],
    });
    expect(sent.leadSessionId).toBe('session-1');

    const ownerInboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const ownerInbox = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(ownerInbox.at(-1).summary).toContain('Approved');
    expect(ownerInbox.at(-1).leadSessionId).toBe('lead-session-1');

    const proc = controller.processes.registerProcess({
      pid: process.pid,
      label: 'dev-server',
      port: '3000',
    });
    expect(proc.port).toBe(3000);
    expect(controller.processes.listProcesses()).toHaveLength(1);
    const stopped = controller.processes.stopProcess({ pid: process.pid });
    expect(typeof stopped.stoppedAt).toBe('string');
  });

  it('builds member briefing from team config language and known member metadata', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.language = 'en';
    config.projectPath = '/tmp/project-x';
    config.members = [
      { name: 'alice', role: 'team-lead' },
      { name: 'bob', role: 'developer', workflow: 'Implement carefully', cwd: '/tmp/project-x' },
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const controller = createController({ teamName: 'my-team', claudeDir });
    controller.tasks.createTask({ subject: 'Queued task', owner: 'bob' });
    const briefing = await controller.tasks.memberBriefing('bob');

    expect(briefing).toContain('Member briefing for bob on team "my-team" (my-team).');
    expect(briefing).toContain('IMPORTANT: Communicate in English.');
    expect(briefing).toContain('TURN ACTION MODE PROTOCOL (HIGHEST PRIORITY FOR EACH USER TURN):');
    expect(briefing).toContain('Workflow:');
    expect(briefing).toContain('Implement carefully');
    expect(briefing).toContain('Working directory: /tmp/project-x');
    expect(briefing).toContain('Task briefing for bob:');
    expect(briefing).toContain('Use task_briefing as your primary working queue whenever you need to see assigned work.');
    expect(briefing).toContain('Use task_list only to search/browse inventory rows, not as your working queue.');
    expect(briefing).toContain(
      'Awareness items are watch-only context and do not authorize you to start work unless the lead reroutes the task or you become the actionOwner.'
    );
    expect(briefing).toContain('After task_complete, notify your team lead via SendMessage.');
    expect(briefing).toContain('Full details in task comment e5f6a7b8');
    expect(briefing).not.toContain('task_get_comment {');
  });

  it('uses OpenCode-native visible-message wording for OpenCode member briefing', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.members = [
      { name: 'alice', role: 'team-lead' },
      { name: 'bob', role: 'developer', providerId: 'opencode', model: 'openrouter/test-model' },
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const controller = createController({ teamName: 'my-team', claudeDir });
    const briefing = await controller.tasks.memberBriefing('bob');

    expect(briefing).toContain(
      'After task_complete, notify your team lead via MCP tool agent-teams_message_send.'
    );
    expect(briefing).toContain('OpenCode visible messaging rule: call agent-teams_message_send');
    expect(briefing).toContain('OpenCode bootstrap silence rule');
    expect(briefing).toContain(
      'If it shows no actionable tasks, stop and wait silently.'
    );
    expect(briefing).toContain(
      'agent-teams_message_send { teamName: "my-team", to: "alice", from: "bob"'
    );
    expect(briefing).toContain('Full details in task comment e5f6a7b8');
    expect(briefing).toContain('Never invent placeholder task refs such as #00000000');
    expect(briefing).not.toContain('task_get_comment {');
    expect(briefing).not.toContain('notify your team lead via SendMessage');
  });

  it('rejects OpenCode idle acknowledgements without explicit delivery context', () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.members = [
      { name: 'alice', role: 'team-lead' },
      { name: 'bob', role: 'developer', providerId: 'opencode', model: 'opencode/test-model' },
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const controller = createController({ teamName: 'my-team', claudeDir });

    expect(() =>
      controller.messages.sendMessage({
        to: 'user',
        from: 'bob',
        text: 'Понял.',
      })
    ).toThrow('OpenCode idle/ack-only message_send was not delivered');

    expect(() =>
      controller.messages.sendMessage({
        to: 'team-lead',
        from: 'bob',
        text: 'Нет назначенных задач.',
      })
    ).toThrow('OpenCode idle/ack-only message_send was not delivered');

    expect(() =>
      controller.messages.sendMessage({
        to: 'user',
        from: 'bob',
        text: 'Понял.',
        source: 'runtime_delivery',
      })
    ).toThrow('OpenCode idle/ack-only message_send was not delivered');

    const delivered = controller.messages.sendMessage({
      to: 'user',
      from: 'bob',
      text: 'Понял.',
      source: 'runtime_delivery',
      relayOfMessageId: 'msg-inbound-1',
    });

    expect(delivered.deliveredToInbox).toBe(true);
  });

  it('strips hallucinated zero task placeholder prefixes from visible messages', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    controller.messages.sendMessage({
      to: 'user',
      from: 'bob',
      text: '#00000000 bootstrap check-in and briefing retrieved. No actionable tasks.',
      summary: '#00000000 ready',
    });

    const userInboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'user.json');
    const rows = JSON.parse(fs.readFileSync(userInboxPath, 'utf8'));
    expect(rows[0].text).toBe('bootstrap check-in and briefing retrieved. No actionable tasks.');
    expect(rows[0].summary).toBe('ready');
  });

  it('does not infer OpenCode briefing from a generic provider-scoped model alone', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.members = [
      { name: 'alice', role: 'team-lead' },
      { name: 'bob', role: 'developer', model: 'openai/gpt-5.4-mini' },
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const controller = createController({ teamName: 'my-team', claudeDir });
    const briefing = await controller.tasks.memberBriefing('bob');

    expect(briefing).toContain('After task_complete, notify your team lead via SendMessage.');
    expect(briefing).not.toContain('agent-teams_message_send');
  });

  it('keeps explicit native provider metadata stronger than OpenCode-looking model labels', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.members = [
      { name: 'alice', role: 'team-lead' },
      { name: 'bob', role: 'developer', providerId: 'codex', model: 'opencode/minimax-m2.5-free' },
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const controller = createController({ teamName: 'my-team', claudeDir });
    const briefing = await controller.tasks.memberBriefing('bob');

    expect(briefing).toContain('After task_complete, notify your team lead via SendMessage.');
    expect(briefing).not.toContain('agent-teams_message_send');
  });

  it('resolves member briefing from members.meta.json when config members are missing', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.language = 'en';
    delete config.members;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.writeFileSync(
      path.join(claudeDir, 'teams', 'my-team', 'members.meta.json'),
      JSON.stringify(
        {
          version: 1,
          members: [{ name: 'bob', role: 'developer', workflow: 'Meta workflow' }],
        },
        null,
        2
      )
    );

    const controller = createController({ teamName: 'my-team', claudeDir });
    const briefing = await controller.tasks.memberBriefing('bob');

    expect(briefing).toContain('Role: developer.');
    expect(briefing).toContain('Meta workflow');
  });

  it('resolves member briefing from inbox presence when member metadata is not persisted yet', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.members;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.mkdirSync(path.join(claudeDir, 'teams', 'my-team', 'inboxes'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'carol.json'), '[]');

    const controller = createController({ teamName: 'my-team', claudeDir });
    const fromInboxBriefing = await controller.tasks.memberBriefing('carol');

    expect(fromInboxBriefing).toContain('Member briefing for carol on team "my-team" (my-team).');
    expect(fromInboxBriefing).toContain('Role: team member.');
  });

  it('rejects member briefing when member is unknown to config, members.meta, and inboxes', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.members;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const controller = createController({ teamName: 'my-team', claudeDir });
    await expect(controller.tasks.memberBriefing('dave')).rejects.toThrow(
      'Member not found in team metadata or inboxes: dave'
    );
  });

  it('ignores pseudo-recipient inbox files when resolving members', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.members;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const inboxDir = path.join(claudeDir, 'teams', 'my-team', 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'cross-team:other-team.json'), '[]');
    fs.writeFileSync(path.join(inboxDir, 'other-team.alice.json'), '[]');
    fs.writeFileSync(path.join(inboxDir, 'cross_team_send.json'), '[]');

    const controller = createController({ teamName: 'my-team', claudeDir });
    await expect(controller.tasks.memberBriefing('cross-team:other-team')).rejects.toThrow(
      'Member not found in team metadata or inboxes: cross-team:other-team'
    );
    await expect(controller.tasks.memberBriefing('other-team.alice')).rejects.toThrow(
      'Member not found in team metadata or inboxes: other-team.alice'
    );
    await expect(controller.tasks.memberBriefing('cross_team_send')).rejects.toThrow(
      'Member not found in team metadata or inboxes: cross_team_send'
    );
  });

  it('rejects member briefing for explicitly removed members', async () => {
    const claudeDir = makeClaudeDir();
    fs.writeFileSync(
      path.join(claudeDir, 'teams', 'my-team', 'members.meta.json'),
      JSON.stringify(
        {
          version: 1,
          members: [{ name: 'carol', role: 'developer', removedAt: Date.now() }],
        },
        null,
        2
      )
    );

    const controller = createController({ teamName: 'my-team', claudeDir });
    await expect(controller.tasks.memberBriefing('carol')).rejects.toThrow(
      'Member is removed from the team: carol'
    );
  });

  it('creates a fresh registry entry when an old pid was recycled without stoppedAt', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const processesPath = path.join(claudeDir, 'teams', 'my-team', 'processes.json');

    fs.writeFileSync(
      processesPath,
      JSON.stringify(
        [
          {
            id: 'old-entry',
            pid: 999999,
            label: 'stale',
            registeredAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        null,
        2
      )
    );

    const registered = controller.processes.registerProcess({
      pid: 999999,
      label: 'fresh',
    });

    expect(registered.id).not.toBe('old-entry');
    const rows = JSON.parse(fs.readFileSync(processesPath, 'utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[0].stoppedAt).toBeTruthy();
    expect(rows[1].id).toBe(registered.id);
  });

  it('keeps assigned tasks pending by default, supports explicit immediate start, notifies owners, and groups briefing into actionable and awareness queues', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const pendingTask = controller.tasks.createTask({
      subject: 'Queued task',
      description: 'Do this later',
      owner: 'bob',
      prompt: 'Check the migration plan first.',
    });
    const activeTask = controller.tasks.createTask({
      subject: 'Active task',
      description: 'Resume immediately',
      owner: 'bob',
      startImmediately: true,
    });
    const completedTask = controller.tasks.createTask({
      subject: 'Already done',
      description: 'Completed task description should stay out of compact rows',
      owner: 'bob',
    });
    controller.tasks.completeTask(completedTask.id, 'bob');
    controller.tasks.addTaskComment(activeTask.id, { from: 'bob', text: 'Resumed work with latest context.' });
    const needsFixTask = controller.tasks.createTask({
      subject: 'Fix after review',
      owner: 'bob',
      status: 'pending',
      reviewState: 'needsFix',
      createdAt: '2026-01-02T00:00:00.000Z',
      notifyOwner: false,
    });
    const reviewTask = controller.tasks.createTask({
      subject: 'Waiting for review',
      owner: 'bob',
      status: 'completed',
      reviewState: 'review',
      createdAt: '2026-01-03T00:00:00.000Z',
      notifyOwner: false,
    });
    const approvedTask = controller.tasks.createTask({
      subject: 'Approved work',
      owner: 'bob',
      status: 'completed',
      reviewState: 'approved',
      createdAt: '2026-01-04T00:00:00.000Z',
      notifyOwner: false,
    });

    const reassignedTask = controller.tasks.createTask({ subject: 'Reassigned later' });
    controller.tasks.setTaskOwner(reassignedTask.id, 'bob');

    expect(pendingTask.status).toBe('pending');
    expect(activeTask.status).toBe('in_progress');

    const ownerInboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const ownerInbox = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(ownerInbox).toHaveLength(4);
    expect(ownerInbox[0].summary).toContain(`#${pendingTask.displayId}`);
    expect(ownerInbox[0].text).toContain('task_get');
    expect(ownerInbox[0].text).toContain('task_start');
    expect(ownerInbox[0].text).toContain('task_add_comment');
    expect(ownerInbox[0].text).toContain('If you are idle and this task is ready to start, start it now.');
    expect(ownerInbox[0].text).toContain(
      'If you are busy, blocked, or still need more context, immediately add a short task comment'
    );
    expect(ownerInbox[0].text).toContain('Description:');
    expect(ownerInbox[0].text).toContain('Do this later');
    expect(ownerInbox[0].text).toContain('Instructions:');
    expect(ownerInbox[0].text).toContain('Check the migration plan first.');
    expect(ownerInbox[0].leadSessionId).toBe('lead-session-1');
    expect(ownerInbox[3].summary).toContain(`#${reassignedTask.displayId}`);
    expect(ownerInbox[3].text).toContain('If you are idle and this task is ready to start, start it now.');
    expect(ownerInbox[3].text).toContain('task_add_comment');

    const briefing = await controller.tasks.taskBriefing('bob');
    expect(briefing).toContain(
      'Primary queue for bob. Act only on Actionable items. Awareness items are watch-only context unless the lead reroutes the task or you become the actionOwner.'
    );
    expect(briefing).toContain(
      'Use task_list only to search/browse inventory rows, not as your working queue.'
    );
    expect(briefing).toContain('Actionable:');
    expect(briefing).toContain(`#${activeTask.displayId}`);
    expect(briefing).toContain('Description: Resume immediately');
    expect(briefing).toContain('Resumed work with latest context.');
    expect(briefing).toContain(`#${needsFixTask.displayId}`);
    expect(briefing).toContain('reason=needs_fix');
    expect(briefing).toContain(`#${pendingTask.displayId}`);
    expect(briefing).not.toContain('Description: Do this later');
    expect(briefing).toContain('Awareness:');
    expect(briefing).toContain(`#${reviewTask.displayId}`);
    expect(briefing).toContain('reason=review_reviewer_missing');
    expect(briefing).toContain(`#${completedTask.displayId}`);
    expect(briefing).not.toContain(
      'Completed task description should stay out of compact rows'
    );
    expect(briefing).toContain(`#${approvedTask.displayId}`);
    expect(briefing).toContain('Counters: actionable=4, awareness=3');
  });

  it('treats stale legacy terminal reviewState on pending tasks as owner-ready work', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const staleTask = controller.tasks.createTask({
      subject: 'Legacy stale approved task',
      owner: 'bob',
      status: 'pending',
      reviewState: 'approved',
      notifyOwner: false,
    });

    const briefing = await controller.tasks.taskBriefing('bob');
    const staleLine = briefing.split('\n').find((line) => line.includes(`#${staleTask.displayId}`));
    expect(staleLine).toContain('[status=pending]');
    expect(staleLine).not.toContain('review=');
    expect(staleLine).toContain('reason=owner_ready');

    const rows = controller.tasks.listTaskInventory({ owner: 'bob' });
    expect(rows.find((row) => row.id === staleTask.id)).toMatchObject({
      status: 'pending',
      reviewState: 'none',
    });
  });

  it('reconciles stale kanban rows and linked inbox comments idempotently', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({
      subject: 'Ship migration',
      owner: 'bob',
    });

    const kanbanPath = path.join(claudeDir, 'teams', 'my-team', 'kanban-state.json');
    fs.writeFileSync(
      kanbanPath,
      JSON.stringify(
        {
          teamName: 'my-team',
          reviewers: [],
          tasks: {
            [task.id]: { column: 'review', movedAt: '2026-01-01T00:00:00.000Z', reviewer: null },
            staleTask: { column: 'approved', movedAt: '2026-01-01T00:00:00.000Z' },
          },
          columnOrder: {
            review: [task.id, 'staleTask'],
            approved: ['staleTask'],
          },
        },
        null,
        2
      )
    );

    const inboxDir = path.join(claudeDir, 'teams', 'my-team', 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(inboxDir, 'bob.json'),
      JSON.stringify(
        [
          {
            from: 'alice',
            to: 'bob',
            summary: `Please revisit #${task.displayId}`,
            messageId: 'm-1',
            timestamp: '2026-02-23T10:00:00.000Z',
            read: false,
            text: 'Need one more verification pass.',
          },
          {
            from: 'team-lead',
            to: 'bob',
            summary: `Comment on #${task.displayId}`,
            messageId: 'm-2',
            timestamp: '2026-02-23T11:00:00.000Z',
            read: false,
            text:
              `**Comment on task #${task.displayId}**\n> Ship migration\n\n> Heads up\n\n` +
              '<agent-block>\nReply to this comment using:\nnode "tool.js" --team my-team task comment 1 --text "..." --from "bob"\n</agent-block>',
          },
        ],
        null,
        2
      )
    );

    const first = controller.maintenance.reconcileArtifacts({ reason: 'manual' });
    expect(first.staleKanbanEntriesRemoved).toBe(1);
    expect(first.staleColumnOrderRefsRemoved).toBe(2);
    expect(first.linkedCommentsCreated).toBe(1);

    const reloaded = controller.tasks.getTask(task.id);
    expect(reloaded.comments).toHaveLength(1);
    expect(reloaded.comments[0].id).toBe('msg-m-1');
    expect(reloaded.comments[0].text).toBe('Need one more verification pass.');

    const cleanedKanban = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    expect(cleanedKanban.tasks.staleTask).toBeUndefined();
    expect(cleanedKanban.columnOrder.review).toEqual([task.id]);
    expect(cleanedKanban.columnOrder.approved).toBeUndefined();

    const second = controller.maintenance.reconcileArtifacts({ reason: 'manual' });
    expect(second.staleKanbanEntriesRemoved).toBe(0);
    expect(second.staleColumnOrderRefsRemoved).toBe(0);
    expect(second.linkedCommentsCreated).toBe(0);
  });

  it('tracks lifecycle history and intervals without duplicate same-status transitions', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Lifecycle task' });

    expect(task.status).toBe('pending');
    expect(task.historyEvents).toHaveLength(1);
    expect(task.workIntervals).toBeUndefined();

    const started = controller.tasks.startTask(task.id, 'bob');
    const startedAgain = controller.tasks.startTask(task.id, 'bob');
    const completed = controller.tasks.completeTask(task.id, 'bob');
    const completedAgain = controller.tasks.completeTask(task.id, 'bob');
    const deleted = controller.tasks.softDeleteTask(task.id, 'bob');
    const restored = controller.tasks.restoreTask(task.id, 'bob');

    expect(started.status).toBe('in_progress');
    expect(startedAgain.historyEvents).toHaveLength(2);
    expect(startedAgain.workIntervals).toHaveLength(1);
    expect(startedAgain.workIntervals[0].startedAt).toBeTruthy();

    expect(completed.status).toBe('completed');
    expect(completedAgain.historyEvents).toHaveLength(3);
    expect(completedAgain.workIntervals).toHaveLength(1);
    expect(completedAgain.workIntervals[0].completedAt).toBeTruthy();

    expect(deleted.status).toBe('deleted');
    expect(deleted.deletedAt).toBeTruthy();
    expect(restored.status).toBe('pending');
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.historyEvents).toHaveLength(5);

    // Verify the event sequence: task_created, then 4 status_changed events
    const types = restored.historyEvents.map((e) => e.type);
    expect(types).toEqual([
      'task_created',
      'status_changed',
      'status_changed',
      'status_changed',
      'status_changed',
    ]);

    // Verify the status flow: pending -> in_progress -> completed -> deleted -> pending
    const firstEvent = restored.historyEvents[0];
    expect(firstEvent.status).toBe('pending');
    const statusChanges = restored.historyEvents.slice(1).map((e) => e.to);
    expect(statusChanges).toEqual([
      'in_progress',
      'completed',
      'deleted',
      'pending',
    ]);
  });

  it('wraps review instructions in the canonical agent block format used by the UI', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Review me', owner: 'bob' });

    controller.kanban.addReviewer('alice');
    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead' });

    const reviewerInboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'alice.json');
    const inbox = JSON.parse(fs.readFileSync(reviewerInboxPath, 'utf8'));

    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toContain('<info_for_agent>');
    expect(inbox[0].text).toContain('review_approve');
    expect(inbox[0].text).not.toContain('<agent-block>');
    expect(inbox[0].leadSessionId).toBe('lead-session-1');
  });

  it('ignores mismatched leadSessionId placeholders on review_request and uses canonical config session', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Review me', owner: 'bob' });

    controller.kanban.addReviewer('alice');
    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, {
      from: 'team-lead',
      leadSessionId: 'team-lead',
    });

    const reviewerInboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'alice.json');
    const inbox = JSON.parse(fs.readFileSync(reviewerInboxPath, 'utf8'));

    expect(inbox).toHaveLength(1);
    expect(inbox[0].leadSessionId).toBe('lead-session-1');
  });

  it('starts review idempotently after review_request', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Review me', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });

    const result = controller.review.startReview(task.id, { from: 'alice' });
    expect(result.ok).toBe(true);
    expect(result.taskId).toBe(task.id);
    expect(result.displayId).toBe(task.displayId);
    expect(result.column).toBe('review');

    // Verify kanban state
    const kanbanState = controller.kanban.getKanbanState();
    expect(kanbanState.tasks[task.id].column).toBe('review');

    // Verify task reviewState
    const updatedTask = controller.tasks.getTask(task.id);
    expect(updatedTask.reviewState).toBe('review');

    // Verify history event
    const reviewEvent = updatedTask.historyEvents.find((e) => e.type === 'review_started');
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent.from).toBe('review');
    expect(reviewEvent.to).toBe('review');
    expect(reviewEvent.actor).toBe('alice');

    // Idempotent: calling again should also succeed without duplicate events
    const again = controller.review.startReview(task.id, { from: 'alice' });
    expect(again.ok).toBe(true);
    const reloaded = controller.tasks.getTask(task.id);
    const startedEvents = reloaded.historyEvents.filter((e) => e.type === 'review_started');
    expect(startedEvents).toHaveLength(1);
  });

  it('records review_start after review_request and surfaces review_in_progress for the reviewer', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Queued for review', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    const started = controller.review.startReview(task.id, { from: 'alice' });

    expect(started.ok).toBe(true);
    const reloaded = controller.tasks.getTask(task.id);
    const requestedEvents = reloaded.historyEvents.filter((e) => e.type === 'review_requested');
    const startedEvents = reloaded.historyEvents.filter((e) => e.type === 'review_started');
    expect(requestedEvents).toHaveLength(1);
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].from).toBe('review');
    expect(startedEvents[0].to).toBe('review');
    expect(startedEvents[0].actor).toBe('alice');

    const reviewerBriefing = await controller.tasks.taskBriefing('alice');
    expect(reviewerBriefing).toContain(`#${task.displayId}`);
    expect(reviewerBriefing).toContain('reason=review_in_progress');
    expect(reviewerBriefing).toContain('reviewer=alice');
  });

  it('uses the assigned reviewer when review_start omits from', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Queued for implicit reviewer', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.review.startReview(task.id);

    const reloaded = controller.tasks.getTask(task.id);
    const startedEvent = reloaded.historyEvents.find((event) => event.type === 'review_started');
    expect(startedEvent.actor).toBe('alice');

    const reviewerBriefing = await controller.tasks.taskBriefing('alice');
    expect(reviewerBriefing).toContain(`#${task.displayId}`);
    expect(reviewerBriefing).toContain('reason=review_in_progress');
    expect(reviewerBriefing).toContain('reviewer=alice');
  });

  it('rejects review terminal transitions outside active completed review tasks', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const pendingTask = controller.tasks.createTask({ subject: 'Pending task', owner: 'bob' });
    expect(() => controller.review.approveReview(pendingTask.id, { from: 'alice' })).toThrow(
      'must be completed before approval'
    );

    const completedTask = controller.tasks.createTask({ subject: 'Completed but not review', owner: 'bob' });
    controller.tasks.completeTask(completedTask.id, 'bob');
    expect(() =>
      controller.review.requestChanges(completedTask.id, { from: 'alice', comment: 'Fix it' })
    ).toThrow('must be in review before requesting changes');

    const deletedTask = controller.tasks.createTask({ subject: 'Deleted review task', owner: 'bob' });
    controller.tasks.softDeleteTask(deletedTask.id, 'bob');
    expect(() => controller.review.approveReview(deletedTask.id, { from: 'alice' })).toThrow('is deleted');
    expect(() =>
      controller.review.requestChanges(deletedTask.id, { from: 'alice', comment: 'Fix it' })
    ).toThrow('is deleted');
    expect(controller.tasks.getTask(deletedTask.id).status).toBe('deleted');
  });

  it('rejects review_start outside active review and keeps owner routing intact', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const pendingTask = controller.tasks.createTask({ subject: 'Pending implementation', owner: 'bob' });
    expect(() => controller.review.startReview(pendingTask.id, { from: 'alice' })).toThrow(
      'must be completed before starting review'
    );
    expect(controller.tasks.getTask(pendingTask.id).reviewState).toBe('none');

    const completedTask = controller.tasks.createTask({ subject: 'Completed without review request', owner: 'bob' });
    controller.tasks.completeTask(completedTask.id, 'bob');
    expect(() => controller.review.startReview(completedTask.id, { from: 'alice' })).toThrow(
      'must be in review before starting review'
    );

    const bobBriefing = await controller.tasks.taskBriefing('bob');
    expect(bobBriefing).toContain(`#${pendingTask.displayId}`);
    expect(bobBriefing).toContain('actionOwner=@bob');
    expect(bobBriefing).not.toContain('reason=review_in_progress');
  });

  it('rejects direct kanban lifecycle bypasses while allowing repair of matching review state', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const pendingTask = controller.tasks.createTask({ subject: 'Kanban bypass pending', owner: 'bob' });
    expect(() => controller.kanban.setKanbanColumn(pendingTask.id, 'approved')).toThrow(
      'must be completed before moving to APPROVED column'
    );

    const completedTask = controller.tasks.createTask({ subject: 'Kanban bypass completed', owner: 'bob' });
    controller.tasks.completeTask(completedTask.id, 'bob');
    expect(() => controller.kanban.setKanbanColumn(completedTask.id, 'review')).toThrow(
      'must be in review before moving to REVIEW column'
    );

    controller.review.requestReview(completedTask.id, { from: 'team-lead', reviewer: 'alice' });
    const kanbanPath = path.join(claudeDir, 'teams', 'my-team', 'kanban-state.json');
    const state = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    delete state.tasks[completedTask.id];
    fs.writeFileSync(kanbanPath, JSON.stringify(state, null, 2));

    controller.kanban.setKanbanColumn(completedTask.id, 'review');
    expect(controller.kanban.getKanbanState().tasks[completedTask.id].column).toBe('review');
  });

  it('rejects review_request for already approved tasks until work is reopened', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Approved terminal task', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.review.startReview(task.id, { from: 'alice' });
    controller.review.approveReview(task.id, { from: 'alice' });

    expect(() => controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' })).toThrow(
      'is already approved'
    );
    expect(controller.tasks.getTask(task.id).reviewState).toBe('approved');
    expect(controller.kanban.getKanbanState().tasks[task.id].column).toBe('approved');
  });

  it('repairs kanban on idempotent review transitions without duplicate history', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Repair review column', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.review.startReview(task.id, { from: 'alice' });

    const kanbanPath = path.join(claudeDir, 'teams', 'my-team', 'kanban-state.json');
    const reviewState = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    delete reviewState.tasks[task.id];
    reviewState.columnOrder = { review: [] };
    fs.writeFileSync(kanbanPath, JSON.stringify(reviewState, null, 2));

    controller.review.startReview(task.id, { from: 'alice' });
    expect(controller.kanban.getKanbanState().tasks[task.id].column).toBe('review');
    expect(
      controller.tasks.getTask(task.id).historyEvents.filter((event) => event.type === 'review_started')
    ).toHaveLength(1);

    controller.review.approveReview(task.id, { from: 'alice' });
    const approvedState = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    delete approvedState.tasks[task.id];
    approvedState.columnOrder = { approved: [] };
    fs.writeFileSync(kanbanPath, JSON.stringify(approvedState, null, 2));

    const approvedAgain = controller.review.approveReview(task.id, { from: 'alice' });
    expect(approvedAgain.alreadyApproved).toBe(true);
    expect(controller.kanban.getKanbanState().tasks[task.id].column).toBe('approved');
    expect(
      controller.tasks.getTask(task.id).historyEvents.filter((event) => event.type === 'review_approved')
    ).toHaveLength(1);
  });

  it('throws when starting review on a deleted task', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Deleted task', owner: 'bob' });
    controller.tasks.softDeleteTask(task.id, 'bob');

    expect(() => controller.review.startReview(task.id, { from: 'alice' })).toThrow('is deleted');
  });

  it('clears stale needsFix reviewState when owner restarts work', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Needs fix restart', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.review.requestChanges(task.id, { from: 'alice', comment: 'Please fix.' });
    const started = controller.tasks.startTask(task.id, 'bob');

    expect(started.status).toBe('in_progress');
    expect(started.reviewState).toBe('none');
    expect(controller.tasks.getTask(task.id).reviewState).toBe('none');
    expect(controller.tasks.listTaskInventory({ owner: 'bob' })[0].reviewState).toBe('none');

    const briefing = await controller.tasks.taskBriefing('bob');
    expect(briefing).toContain('reason=owner_executing');
    expect(briefing).not.toContain('reason=needs_fix');
  });

  it('persists full inbox metadata through controller messages.sendMessage', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const sent = controller.messages.sendMessage({
      to: 'bob',
      from: 'team-lead',
      text: 'Need your review',
      summary: 'Review request',
      commentId: 'comment-123',
      relayOfMessageId: 'm-original-1',
      source: 'system_notification',
      messageKind: 'task_comment_notification',
      leadSessionId: 'session-42',
      attachments: [{ id: 'a1', filename: 'note.txt', mimeType: 'text/plain', size: 7 }],
    });

    expect(sent.deliveredToInbox).toBe(true);
    expect(sent.messageId).toBeTruthy();

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('system_notification');
    expect(rows[0].messageKind).toBe('task_comment_notification');
    expect(rows[0].commentId).toBe('comment-123');
    expect(rows[0].relayOfMessageId).toBe('m-original-1');
    expect(rows[0].leadSessionId).toBe('session-42');
    expect(rows[0].attachments[0].filename).toBe('note.txt');
  });

  it('persists slash command metadata through controller messages.appendSentMessage', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    controller.messages.appendSentMessage({
      from: 'user',
      to: 'alice',
      text: '/compact keep only kanban context',
      messageKind: 'slash_command',
      slashCommand: {
        name: 'compact',
        command: '/compact',
        args: 'keep only kanban context',
        knownDescription: 'Compact the active context',
      },
    });

    controller.messages.appendSentMessage({
      from: 'alice',
      to: 'user',
      text: 'Compacted context.',
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/compact',
      },
    });

    const sentPath = path.join(claudeDir, 'teams', 'my-team', 'sentMessages.json');
    const rows = JSON.parse(fs.readFileSync(sentPath, 'utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[0].messageKind).toBe('slash_command');
    expect(rows[0].slashCommand).toMatchObject({
      name: 'compact',
      command: '/compact',
      args: 'keep only kanban context',
    });
    expect(rows[1].messageKind).toBe('slash_command_result');
    expect(rows[1].commandOutput).toEqual({
      stream: 'stdout',
      commandLabel: '/compact',
    });
  });

  it('canonicalizes local message recipients and guards user-directed sender identity', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    controller.messages.sendMessage({
      to: 'team-lead',
      from: 'bob',
      text: 'Need lead input',
      summary: 'Lead input',
      actionMode: 'ask',
    });

    const leadInboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'alice.json');
    const leadRows = JSON.parse(fs.readFileSync(leadInboxPath, 'utf8'));
    expect(leadRows).toHaveLength(1);
    expect(leadRows[0].to).toBe('alice');
    expect(leadRows[0].from).toBe('bob');
    expect(leadRows[0].actionMode).toBe('ask');

    controller.messages.sendMessage({
      to: 'user',
      from: 'lead',
      text: 'Visible user reply',
      summary: 'Reply',
    });

    const userInboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'user.json');
    const userRows = JSON.parse(fs.readFileSync(userInboxPath, 'utf8'));
    expect(userRows).toHaveLength(1);
    expect(userRows[0].to).toBe('user');
    expect(userRows[0].from).toBe('alice');

    expect(() =>
      controller.messages.sendMessage({
        to: 'user',
        text: 'Missing sender',
      })
    ).toThrow('message_send to user requires from to be the responding team member name');

    expect(() =>
      controller.messages.sendMessage({
        to: 'other-team.alice',
        from: 'bob',
        text: 'Wrong transport',
      })
    ).toThrow('message_send cannot target another team. Use cross_team_send with toTeam.');

    expect(() =>
      controller.messages.sendMessage({
        to: 'cross_team_send',
        from: 'bob',
        text: 'Wrong transport',
      })
    ).toThrow('message_send cannot target cross_team_send. Use cross_team_send with toTeam.');
  });

  it('wakes task owner on regular comment from another member', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Investigate', owner: 'bob', notifyOwner: false });

    const commented = controller.tasks.addTaskComment(task.id, {
      from: 'alice',
      text: 'I found the root cause.',
    });

    expect(commented.task.comments.at(-1).text).toBe('I found the root cause.');
    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain(`#${task.displayId}`);
    expect(rows[0].text).toContain('I found the root cause.');
    expect(rows[0].leadSessionId).toBe('lead-session-1');
  });

  it('includes the assigned task ref in owner assignment notifications', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const task = controller.tasks.createTask({
      subject: 'Implement runtime handoff',
      owner: 'bob',
      descriptionTaskRefs: [{ taskId: 'related-task', displayId: 'rel12345', teamName: 'my-team' }],
    });

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe(`New task #${task.displayId} assigned`);
    expect(rows[0].taskRefs).toEqual([
      { taskId: task.id, displayId: task.displayId, teamName: 'my-team' },
      { taskId: 'related-task', displayId: 'rel12345', teamName: 'my-team' },
    ]);
  });

  it('does not wake owner for self-comments and keeps user clarification sticky until explicitly cleared', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({
      subject: 'Need product input',
      owner: 'bob',
      needsClarification: 'user',
      notifyOwner: false,
    });

    controller.tasks.addTaskComment(task.id, {
      from: 'bob',
      text: 'Starting to investigate.',
    });

    const ownerInboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    expect(fs.existsSync(ownerInboxPath)).toBe(false);

    const replied = controller.tasks.addTaskComment(task.id, {
      from: 'user',
      text: 'Please use the safer option.',
    });

    expect(replied.task.needsClarification).toBe('user');
    const reloaded = controller.tasks.getTask(task.id);
    expect(reloaded.needsClarification).toBe('user');
    const rows = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain('Please use the safer option.');

    const cleared = controller.tasks.setNeedsClarification(task.id, 'clear');
    expect(cleared.needsClarification).toBeUndefined();
    expect(controller.tasks.getTask(task.id).needsClarification).toBeUndefined();
  });

  it('wakes lead owner on comment from another member', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({
      subject: 'Lead-owned task',
      owner: 'team-lead',
      notifyOwner: false,
    });

    controller.tasks.addTaskComment(task.id, {
      from: 'bob',
      text: 'Need your decision here.',
    });

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'alice.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe('bob');
    expect(rows[0].to).toBe('alice');
    expect(rows[0].text).toContain('Need your decision here.');
  });

  it('moves review back to pending+needsFix and notifies owner on requestChanges', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Needs revision', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const updated = controller.review.requestChanges(task.id, {
      from: 'alice',
      comment: 'Please address review feedback.',
    });

    expect(updated.status).toBe('pending');
    expect(updated.reviewState).toBe('needsFix');
    expect(updated.comments.at(-1).type).toBe('review_request');

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows.at(-1).source).toBe('system_notification');
    expect(rows.at(-1).summary).toContain('Fix request');
    expect(rows.at(-1).text).toContain('moved back to pending');
    expect(rows.at(-1).text).toContain('request review again');
    expect(rows.at(-1).leadSessionId).toBe('lead-session-1');
  });

  it('ignores mismatched leadSessionId placeholders on review_approve owner notifications', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Approve me', owner: 'bob' });

    controller.kanban.addReviewer('alice');
    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.review.approveReview(task.id, {
      from: 'team-lead',
      note: 'Looks good.',
      'notify-owner': true,
      leadSessionId: 'team-lead',
    });

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows.at(-1).summary).toContain('Approved');
    expect(rows.at(-1).leadSessionId).toBe('lead-session-1');
  });

  it('ignores mismatched leadSessionId placeholders on review_request_changes owner notifications', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Needs revision', owner: 'bob' });

    controller.kanban.addReviewer('alice');
    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.review.requestChanges(task.id, {
      from: 'alice',
      comment: 'Please address review feedback.',
      leadSessionId: 'team-lead',
    });

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows.at(-1).summary).toContain('Fix request');
    expect(rows.at(-1).leadSessionId).toBe('lead-session-1');
  });

  it('keeps approved tasks in awareness ordered by freshness', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const approvedTasks = Array.from({ length: 12 }, (_, index) =>
      controller.tasks.createTask({
        subject: `Approved ${index + 1}`,
        owner: 'bob',
        status: 'completed',
        reviewState: 'approved',
        createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
    );

    const briefing = await controller.tasks.taskBriefing('bob');
    expect(briefing).toContain('Awareness:');
    expect(briefing).toContain(`#${approvedTasks[11].displayId}`);
    expect(briefing).toContain(`#${approvedTasks[2].displayId}`);
    expect(briefing).toContain(`#${approvedTasks[1].displayId}`);
    expect(briefing).toContain(`#${approvedTasks[0].displayId}`);
    expect(briefing.indexOf(`#${approvedTasks[11].displayId}`)).toBeLessThan(
      briefing.indexOf(`#${approvedTasks[0].displayId}`)
    );
  });

  it('builds derived lead briefing and filtered task inventory', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const queuedTask = controller.tasks.createTask({
      subject: 'Queued implementation',
      owner: 'bob',
      notifyOwner: false,
    });
    const unassignedTask = controller.tasks.createTask({
      subject: 'Needs owner',
      notifyOwner: false,
    });
    const reviewTask = controller.tasks.createTask({
      subject: 'Needs review pickup',
      owner: 'bob',
      notifyOwner: false,
    });

    controller.tasks.completeTask(reviewTask.id, 'bob');
    controller.review.requestReview(reviewTask.id, { from: 'alice', reviewer: 'alice' });

    const leadBriefing = await controller.tasks.leadBriefing();
    expect(leadBriefing).toContain('Lead queue for alice on team "my-team":');
    expect(leadBriefing).toContain(
      'Primary lead queue. Sections below already represent lead-owned actions or watch-only context.'
    );
    expect(leadBriefing).toContain(
      'Use task_list only for search, filtering, and drill-down inventory lookups.'
    );
    expect(leadBriefing).toContain('Needs owner assignment:');
    expect(leadBriefing).toContain(`#${unassignedTask.displayId}`);
    expect(leadBriefing).toContain('Lead-owned follow-up:');
    expect(leadBriefing).toContain(`#${reviewTask.displayId}`);

    const reviewInventory = controller.tasks.listTaskInventory({ reviewState: 'review' });
    expect(reviewInventory).toHaveLength(1);
    expect(reviewInventory[0].id).toBe(reviewTask.id);

    const ownerPendingInventory = controller.tasks.listTaskInventory({
      owner: 'bob',
      status: 'pending',
    });
    expect(ownerPendingInventory.map((task) => task.id)).toEqual([queuedTask.id]);
  });

  it('uses legacy kanban reviewer as a migration fallback for active review tasks', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.members.push({ name: 'carol', role: 'reviewer' });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const controller = createController({ teamName: 'my-team', claudeDir });
    const reviewTask = controller.tasks.createTask({
      subject: 'Legacy review assignment',
      owner: 'bob',
      status: 'completed',
      reviewState: 'review',
      notifyOwner: false,
    });

    fs.writeFileSync(
      path.join(claudeDir, 'teams', 'my-team', 'kanban-state.json'),
      JSON.stringify(
        {
          teamName: 'my-team',
          reviewers: [],
          tasks: {
            [reviewTask.id]: {
              column: 'review',
              reviewer: 'carol',
              movedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
        null,
        2
      )
    );

    const reviewerBriefing = await controller.tasks.taskBriefing('carol');
    expect(reviewerBriefing).toContain(
      'Primary queue for carol. Act only on Actionable items. Awareness items are watch-only context unless the lead reroutes the task or you become the actionOwner.'
    );
    expect(reviewerBriefing).toContain('Actionable:');
    expect(reviewerBriefing).toContain(`#${reviewTask.displayId}`);
    expect(reviewerBriefing).toContain('reviewer=carol');

    const leadBriefing = await controller.tasks.leadBriefing();
    expect(leadBriefing).toContain(
      'Use task_list only for search, filtering, and drill-down inventory lookups.'
    );
    expect(leadBriefing).toContain('Watching:');
    expect(leadBriefing).toContain(`#${reviewTask.displayId}`);
    expect(leadBriefing).not.toContain('review_reviewer_missing');
  });

  it('does not treat role names containing lead as canonical team lead', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          name: 'my-team',
          leadSessionId: 'lead-session-1',
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'alice', role: 'tech lead' },
            { name: 'bob', role: 'developer' },
          ],
        },
        null,
        2
      )
    );

    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Alice owns this', owner: 'alice' });
    const aliceBriefing = await controller.tasks.taskBriefing('alice');
    const leadBriefing = await controller.tasks.leadBriefing();

    expect(aliceBriefing).toContain('Actionable:');
    expect(aliceBriefing).toContain(`#${task.displayId}`);
    expect(aliceBriefing).toContain('actionOwner=@alice');
    expect(leadBriefing).not.toContain(`#${task.displayId}`);
  });

  it('recognizes lead and orchestrator agent types as canonical team leads', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          name: 'my-team',
          leadSessionId: 'lead-session-1',
          members: [
            { name: 'alice', role: 'developer' },
            { name: 'leadbot', agentType: 'lead' },
            { name: 'opsbot', agentType: 'orchestrator' },
          ],
        },
        null,
        2
      )
    );

    const controller = createController({ teamName: 'my-team', claudeDir });
    const aliceTask = controller.tasks.createTask({ subject: 'Alice owns this', owner: 'alice' });
    const leadTask = controller.tasks.createTask({ subject: 'Lead owns this', owner: 'leadbot' });
    const aliceBriefing = await controller.tasks.taskBriefing('alice');
    const leadBriefing = await controller.tasks.leadBriefing();

    expect(aliceBriefing).toContain(`#${aliceTask.displayId}`);
    expect(aliceBriefing).toContain('actionOwner=@alice');
    expect(aliceBriefing).not.toContain(`#${leadTask.displayId}`);
    expect(leadBriefing).toContain(`#${leadTask.displayId}`);
    expect(leadBriefing).not.toContain(`#${aliceTask.displayId}`);
  });

  it('stores canonical member names for lead aliases in owners, reviewers, and reviewer config', () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          name: 'my-team',
          members: [
            { name: 'leadbot', agentType: 'lead' },
            { name: 'alice', role: 'reviewer' },
            { name: 'bob', role: 'developer' },
          ],
        },
        null,
        2
      )
    );

    const controller = createController({ teamName: 'my-team', claudeDir });
    const leadOwnedTask = controller.tasks.createTask({ subject: 'Lead alias owner', owner: 'lead' });
    expect(leadOwnedTask.owner).toBe('leadbot');
    expect(fs.existsSync(path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'lead.json'))).toBe(false);

    const reassignedTask = controller.tasks.createTask({ subject: 'Reassign alias owner', owner: 'bob' });
    expect(controller.tasks.setTaskOwner(reassignedTask.id, 'team-lead').owner).toBe('leadbot');

    controller.kanban.addReviewer('lead');
    expect(controller.kanban.listReviewers()).toEqual(['leadbot']);

    const reviewTask = controller.tasks.createTask({ subject: 'Review alias', owner: 'bob' });
    controller.tasks.completeTask(reviewTask.id, 'bob');
    controller.review.requestReview(reviewTask.id, { from: 'alice', reviewer: 'lead' });

    const requested = controller.tasks
      .getTask(reviewTask.id)
      .historyEvents.filter((event) => event.type === 'review_requested')
      .at(-1);
    expect(requested.reviewer).toBe('leadbot');
    expect(fs.existsSync(path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'leadbot.json'))).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'lead.json'))).toBe(false);
  });

  it('rejects task_briefing for unknown members', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    await expect(controller.tasks.taskBriefing('bbo')).rejects.toThrow(
      'Member not found in team metadata or inboxes: bbo'
    );
  });

  it('warns when task_briefing member exists only because of inbox state', async () => {
    const claudeDir = makeClaudeDir();
    const inboxDir = path.join(claudeDir, 'teams', 'my-team', 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'bbo.json'), '[]', 'utf8');
    const controller = createController({ teamName: 'my-team', claudeDir });

    const briefing = await controller.tasks.taskBriefing('bbo');

    expect(briefing).toContain('Board warnings:');
    expect(briefing).toContain(
      'Member identity warning: bbo is known only from inbox state, not team config/member metadata. Verify the member name before acting.'
    );
  });

  it('clears kanban tasks and column order when review tasks leave review', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Column cleanup', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.kanban.updateColumnOrder('review', [task.id]);
    controller.review.requestChanges(task.id, { from: 'alice', comment: 'Needs work.' });

    let kanbanState = controller.kanban.getKanbanState();
    expect(kanbanState.tasks[task.id]).toBeUndefined();
    expect(kanbanState.columnOrder).toBeUndefined();

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.kanban.updateColumnOrder('review', [task.id]);
    const deleted = controller.tasks.softDeleteTask(task.id, 'bob');

    expect(deleted.status).toBe('deleted');
    expect(deleted.reviewState).toBe('none');
    kanbanState = controller.kanban.getKanbanState();
    expect(kanbanState.tasks[task.id]).toBeUndefined();
    expect(kanbanState.columnOrder).toBeUndefined();
  });

  it('clears kanban tasks and column order when task_set_status deletes a review task', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Generic status delete cleanup', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'team-lead', reviewer: 'alice' });
    controller.kanban.updateColumnOrder('review', [task.id]);
    const deleted = controller.tasks.setTaskStatus(task.id, 'deleted', 'bob');

    expect(deleted.status).toBe('deleted');
    expect(deleted.reviewState).toBe('none');
    const kanbanState = controller.kanban.getKanbanState();
    expect(kanbanState.tasks[task.id]).toBeUndefined();
    expect(kanbanState.columnOrder).toBeUndefined();
  });

  it('surfaces unreadable task rows as board anomalies', async () => {
    const claudeDir = makeClaudeDir();
    fs.writeFileSync(path.join(claudeDir, 'tasks', 'my-team', 'broken.json'), '{ bad json', 'utf8');
    const controller = createController({ teamName: 'my-team', claudeDir });

    const leadBriefing = await controller.tasks.leadBriefing();
    expect(leadBriefing).toContain('Board anomalies:');
    expect(leadBriefing).toContain('unreadable_task (broken)');
    expect(leadBriefing).toContain('anomalies=1');
  });

  it('caps large member briefings and points agents to drill-down tools', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    for (let i = 0; i < 60; i += 1) {
      controller.tasks.createTask({
        subject: `Large queue task ${i}`,
        description: 'x'.repeat(3000),
        owner: 'bob',
        status: 'in_progress',
        comments: Array.from({ length: 8 }, (_, index) => ({
          id: `comment-${i}-${index}`,
          author: 'bob',
          text: 'y'.repeat(1000),
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, i, index)).toISOString(),
        })),
        notifyOwner: false,
      });
    }

    const briefing = await controller.tasks.taskBriefing('bob');
    const renderedTaskLines = briefing.split('\n').filter((line) => line.startsWith('- #'));
    expect(renderedTaskLines.length).toBe(50);
    expect(briefing).toContain('10 more Actionable item(s) omitted');
    expect(briefing).toContain('Use task_list filters and task_get for drill-down.');
    expect(briefing.length).toBeLessThan(100_000);
  });

  it('resets approved review state when work is reopened to pending', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Approved then reopened', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    controller.review.approveReview(task.id, { from: 'alice' });
    const reopened = controller.tasks.setTaskStatus(task.id, 'pending', 'alice');

    expect(reopened.status).toBe('pending');
    expect(reopened.reviewState).toBe('none');
    expect(controller.tasks.listTaskInventory({ reviewState: 'approved' })).toHaveLength(0);
    expect(controller.tasks.listTaskInventory({ owner: 'bob' })[0].reviewState).toBe('none');

    const bobBriefing = await controller.tasks.taskBriefing('bob');
    expect(bobBriefing).toContain(`#${task.displayId}`);
    expect(bobBriefing).toContain('reason=owner_ready');
    expect(bobBriefing).toContain('actionOwner=@bob');
  });

  it('guards direct kanban_clear against active review state while keeping no-op clears safe', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Do not unapprove directly', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    controller.review.approveReview(task.id, { from: 'alice' });

    expect(() => controller.kanban.clearKanban(task.id)).toThrow('reviewState=approved');
    expect(controller.tasks.getTask(task.id).reviewState).toBe('approved');
    expect(controller.kanban.getKanbanState().tasks[task.id].column).toBe('approved');

    controller.tasks.setTaskStatus(task.id, 'pending', 'alice');
    const noOpState = controller.kanban.clearKanban(task.id);
    expect(noOpState.tasks[task.id]).toBeUndefined();
    expect(controller.tasks.getTask(task.id).reviewState).toBe('none');
  });

  it('does not let inbox-only names become real owners or reviewers', async () => {
    const claudeDir = makeClaudeDir();
    const inboxDir = path.join(claudeDir, 'teams', 'my-team', 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'boob.json'), '[]', 'utf8');
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Typo owner guard', owner: 'bob' });

    expect(() => controller.tasks.setTaskOwner(task.id, 'boob')).toThrow('Unknown task owner: boob');
    controller.tasks.completeTask(task.id, 'bob');
    expect(() => controller.review.requestReview(task.id, { from: 'alice', reviewer: 'boob' })).toThrow(
      'Unknown reviewer: boob'
    );

    const taskPath = path.join(claudeDir, 'tasks', 'my-team', `${task.id}.json`);
    const rawTask = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    rawTask.owner = 'boob';
    rawTask.status = 'pending';
    rawTask.reviewState = 'none';
    fs.writeFileSync(taskPath, JSON.stringify(rawTask, null, 2));

    const leadBriefing = await controller.tasks.leadBriefing();
    expect(leadBriefing).toContain(`#${task.displayId}`);
    expect(leadBriefing).toContain('reason=owner_invalid');
    expect(leadBriefing).toContain('Needs owner assignment:');
  });

  it('prevents deleted tasks from being resurrected by normal work tools', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Deleted work guard', owner: 'bob' });

    controller.tasks.softDeleteTask(task.id, 'bob');

    expect(() => controller.tasks.startTask(task.id, 'bob')).toThrow('use task_restore before starting work');
    expect(() => controller.tasks.completeTask(task.id, 'bob')).toThrow('use task_restore before changing status');
    expect(() => controller.tasks.setTaskStatus(task.id, 'pending', 'bob')).toThrow(
      'use task_restore before changing status'
    );

    const restored = controller.tasks.restoreTask(task.id, 'alice');
    expect(restored.status).toBe('pending');
    expect(restored.reviewState).toBe('none');
  });

  it('rejects task_restore for non-deleted tasks', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Approved task must stay approved', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    controller.review.approveReview(task.id, { from: 'alice' });

    expect(() => controller.tasks.restoreTask(task.id, 'alice')).toThrow(
      'task_restore only restores deleted tasks'
    );
    expect(controller.tasks.getTask(task.id).status).toBe('completed');
    expect(controller.tasks.getTask(task.id).reviewState).toBe('approved');
  });

  it('uses actual kanban overlay for kanbanColumn inventory filters', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Approved without overlay', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    controller.review.approveReview(task.id, { from: 'alice' });

    const kanbanPath = path.join(claudeDir, 'teams', 'my-team', 'kanban-state.json');
    const state = JSON.parse(fs.readFileSync(kanbanPath, 'utf8'));
    delete state.tasks[task.id];
    fs.writeFileSync(kanbanPath, JSON.stringify(state, null, 2));

    expect(controller.tasks.listTaskInventory({ reviewState: 'approved' }).map((row) => row.id)).toContain(task.id);
    expect(controller.tasks.listTaskInventory({ kanbanColumn: 'approved' })).toHaveLength(0);
  });

  it('repairs an invalid review_started actor without losing the assigned reviewer', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Repair reviewer actor', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });

    const taskPath = path.join(claudeDir, 'tasks', 'my-team', `${task.id}.json`);
    const rawTask = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    rawTask.historyEvents.push({
      id: 'bad-review-start',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'review_started',
      from: 'review',
      to: 'review',
      actor: 'alicce',
    });
    fs.writeFileSync(taskPath, JSON.stringify(rawTask, null, 2));

    controller.review.startReview(task.id, { from: 'alice' });
    const startedEvents = controller.tasks
      .getTask(task.id)
      .historyEvents.filter((event) => event.type === 'review_started');
    expect(startedEvents.at(-1).actor).toBe('alice');

    const reviewerBriefing = await controller.tasks.taskBriefing('alice');
    expect(reviewerBriefing).toContain(`#${task.displayId}`);
    expect(reviewerBriefing).toContain('reviewer=alice');
    expect(reviewerBriefing).not.toContain('review_reviewer_missing');
  });

  it('repairs a valid but mismatched review_started actor back to the assigned reviewer', async () => {
    const claudeDir = makeClaudeDir();
    const configPath = path.join(claudeDir, 'teams', 'my-team', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.members.push({ name: 'carol', role: 'reviewer' });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Repair mismatched reviewer actor', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });

    const taskPath = path.join(claudeDir, 'tasks', 'my-team', `${task.id}.json`);
    const rawTask = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    rawTask.historyEvents.push({
      id: 'wrong-review-start',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'review_started',
      from: 'review',
      to: 'review',
      actor: 'carol',
    });
    fs.writeFileSync(taskPath, JSON.stringify(rawTask, null, 2));

    controller.review.startReview(task.id);
    const startedEvents = controller.tasks
      .getTask(task.id)
      .historyEvents.filter((event) => event.type === 'review_started');
    expect(startedEvents.at(-1).actor).toBe('alice');

    const aliceBriefing = await controller.tasks.taskBriefing('alice');
    const carolBriefing = await controller.tasks.taskBriefing('carol');
    expect(aliceBriefing).toContain(`#${task.displayId}`);
    expect(aliceBriefing).toContain('reviewer=alice');
    expect(carolBriefing).not.toContain('reason=review_in_progress');
  });

  it('bounds anomaly and subject rendering on primary queue surfaces', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const longSubject = `Long subject ${'x'.repeat(5000)}`;
    const task = controller.tasks.createTask({ subject: longSubject, owner: 'bob', notifyOwner: false });
    const kanbanPath = path.join(claudeDir, 'teams', 'my-team', 'kanban-state.json');
    fs.writeFileSync(
      kanbanPath,
      JSON.stringify(
        {
          teamName: 'my-team',
          reviewers: [],
          tasks: {
            missing: { column: 'review', movedAt: '2026-01-01T00:00:00.000Z' },
          },
          columnOrder: { review: ['missing', task.id] },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(claudeDir, 'tasks', 'my-team', 'bad-status.json'),
      JSON.stringify({ id: 'bad-status', subject: 'Bad status', status: 'inprogress' }, null, 2),
      'utf8'
    );
    for (let index = 0; index < 30; index += 1) {
      fs.writeFileSync(path.join(claudeDir, 'tasks', 'my-team', `broken-${index}.json`), '{ bad json', 'utf8');
    }

    const briefing = await controller.tasks.leadBriefing();
    expect(briefing).toContain('Board anomalies:');
    expect(briefing).toContain('Invalid task status "inprogress"');
    expect(briefing).toContain('stale_kanban_task (missing)');
    expect(briefing).toContain('more board anomaly item(s) omitted');
    expect(briefing).not.toContain('x'.repeat(1000));

    const inventoryRow = controller.tasks.listTaskInventory({ owner: 'bob' })[0];
    expect(inventoryRow.subject).toContain('[truncated]');
    expect(inventoryRow.subject.length).toBeLessThan(300);
  });

  it('marks stale processes stopped during listing and supports unregister', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const processesPath = path.join(claudeDir, 'teams', 'my-team', 'processes.json');

    fs.writeFileSync(
      processesPath,
      JSON.stringify(
        [
          {
            id: 'stale-entry',
            pid: 999999,
            label: 'stale',
            registeredAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        null,
        2
      )
    );

    const listed = controller.processes.listProcesses();
    expect(listed).toHaveLength(1);
    expect(listed[0].alive).toBe(false);
    expect(listed[0].stoppedAt).toBeTruthy();

    const persisted = JSON.parse(fs.readFileSync(processesPath, 'utf8'));
    expect(persisted[0].stoppedAt).toBeTruthy();

    controller.processes.unregisterProcess({ id: 'stale-entry' });
    expect(controller.processes.listProcesses()).toEqual([]);
  });

  it('task_add_comment succeeds even when owner notification write fails', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({
      subject: 'Comment resilience',
      owner: 'bob',
      notifyOwner: false,
    });

    // Make inboxes directory read-only to force notification write failure
    const inboxDir = path.join(claudeDir, 'teams', 'my-team', 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });
    // Write a broken file that will cause JSON parse failure on append
    fs.writeFileSync(path.join(inboxDir, 'bob.json'), 'NOT VALID JSON');

    // Comment should still succeed despite notification failure
    const commented = controller.tasks.addTaskComment(task.id, {
      from: 'alice',
      text: 'This should persist despite notification failure.',
    });

    expect(commented.commentId).toBeTruthy();
    expect(commented.task.comments).toHaveLength(1);
    expect(commented.task.comments[0].text).toBe(
      'This should persist despite notification failure.'
    );
  });

  it('launches and stops a team through the runtime control API bridge', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const calls = [];

    const server = await startControlServer(async ({ method, url, body }) => {
      calls.push({ method, url, body });

      if (method === 'POST' && url === '/api/teams/my-team/launch') {
        return { body: { runId: 'run-123' } };
      }
      if (method === 'GET' && url === '/api/teams/provisioning/run-123') {
        return {
          body: {
            runId: 'run-123',
            teamName: 'my-team',
            state: 'ready',
            message: 'Ready',
            startedAt: '2026-03-12T00:00:00.000Z',
            updatedAt: '2026-03-12T00:00:01.000Z',
          },
        };
      }
      if (method === 'POST' && url === '/api/teams/my-team/stop') {
        return {
          body: {
            teamName: 'my-team',
            isAlive: false,
            runId: null,
            progress: null,
          },
        };
      }
      if (method === 'GET' && url === '/api/teams/my-team/runtime') {
        return {
          body: {
            teamName: 'my-team',
            isAlive: false,
            runId: null,
            progress: null,
          },
        };
      }

      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });

    try {
      const launched = await controller.runtime.launchTeam({
        cwd: '/tmp/project',
        controlUrl: server.baseUrl,
      });
      expect(launched.runId).toBe('run-123');
      expect(launched.isAlive).toBe(true);
      expect(launched.progress.state).toBe('ready');

      const stopped = await controller.runtime.stopTeam({
        controlUrl: server.baseUrl,
      });
      expect(stopped.isAlive).toBe(false);
      expect(stopped.runId).toBeNull();

      expect(calls).toEqual([
        {
          method: 'POST',
          url: '/api/teams/my-team/launch',
          body: { cwd: '/tmp/project' },
        },
        {
          method: 'GET',
          url: '/api/teams/provisioning/run-123',
          body: undefined,
        },
        {
          method: 'POST',
          url: '/api/teams/my-team/stop',
          body: undefined,
        },
        {
          method: 'GET',
          url: '/api/teams/my-team/runtime',
          body: undefined,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('forwards OpenCode runtime MCP calls to the app control API', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const calls = [];

    const server = await startControlServer(async ({ method, url, body }) => {
      calls.push({ method, url, body });
      if (method === 'POST' && url === '/api/teams/my-team/opencode/runtime/bootstrap-checkin') {
        return { body: { ok: true, state: 'accepted' } };
      }
      if (method === 'POST' && url === '/api/teams/my-team/opencode/runtime/deliver-message') {
        return { body: { ok: true, state: 'delivered' } };
      }
      if (method === 'POST' && url === '/api/teams/my-team/opencode/runtime/task-event') {
        return { body: { ok: true, state: 'recorded' } };
      }
      if (method === 'POST' && url === '/api/teams/my-team/opencode/runtime/heartbeat') {
        return { body: { ok: true, state: 'accepted' } };
      }
      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });

    try {
      await controller.runtime.runtimeBootstrapCheckin({
        controlUrl: server.baseUrl,
        runId: 'run-oc',
        memberName: 'bob',
        runtimeSessionId: 'ses-1',
      });
      await controller.runtime.runtimeDeliverMessage({
        controlUrl: server.baseUrl,
        idempotencyKey: 'idem-1',
        runId: 'run-oc',
        fromMemberName: 'bob',
        runtimeSessionId: 'ses-1',
        to: 'user',
        text: 'hello',
      });
      await controller.runtime.runtimeTaskEvent({
        controlUrl: server.baseUrl,
        idempotencyKey: 'idem-task-1',
        runId: 'run-oc',
        memberName: 'bob',
        runtimeSessionId: 'ses-1',
        taskId: 'task-1',
        event: 'started',
      });
      await controller.runtime.runtimeHeartbeat({
        controlUrl: server.baseUrl,
        runId: 'run-oc',
        memberName: 'bob',
        runtimeSessionId: 'ses-1',
      });

      expect(calls.map((call) => call.url)).toEqual([
        '/api/teams/my-team/opencode/runtime/bootstrap-checkin',
        '/api/teams/my-team/opencode/runtime/deliver-message',
        '/api/teams/my-team/opencode/runtime/task-event',
        '/api/teams/my-team/opencode/runtime/heartbeat',
      ]);
      expect(calls[0].body).toEqual({
        teamName: 'my-team',
        runId: 'run-oc',
        memberName: 'bob',
        runtimeSessionId: 'ses-1',
      });
    } finally {
      await server.close();
    }
  });

  it('prefers the published control endpoint over a stale env URL', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const previousUrl = process.env.CLAUDE_TEAM_CONTROL_URL;

    const server = await startControlServer(async ({ method, url }) => {
      if (method === 'POST' && url === '/api/teams/my-team/launch') {
        return { body: { runId: 'run-fresh' } };
      }
      if (method === 'GET' && url === '/api/teams/provisioning/run-fresh') {
        return {
          body: {
            runId: 'run-fresh',
            teamName: 'my-team',
            state: 'ready',
            message: 'Ready',
            startedAt: '2026-03-12T00:00:00.000Z',
            updatedAt: '2026-03-12T00:00:01.000Z',
          },
        };
      }
      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });

    try {
      process.env.CLAUDE_TEAM_CONTROL_URL = 'http://127.0.0.1:1';
      writeControlApiState(claudeDir, server.baseUrl);

      const launched = await controller.runtime.launchTeam({
        cwd: '/tmp/project',
      });

      expect(launched.runId).toBe('run-fresh');
      expect(launched.progress.state).toBe('ready');
    } finally {
      if (previousUrl === undefined) {
        delete process.env.CLAUDE_TEAM_CONTROL_URL;
      } else {
        process.env.CLAUDE_TEAM_CONTROL_URL = previousUrl;
      }
      await server.close();
    }
  });

  it('falls back to the env endpoint when the published control file is stale', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const previousUrl = process.env.CLAUDE_TEAM_CONTROL_URL;

    const server = await startControlServer(async ({ method, url }) => {
      if (method === 'POST' && url === '/api/teams/my-team/launch') {
        return { body: { runId: 'run-env' } };
      }
      if (method === 'GET' && url === '/api/teams/provisioning/run-env') {
        return {
          body: {
            runId: 'run-env',
            teamName: 'my-team',
            state: 'ready',
            message: 'Ready',
            startedAt: '2026-03-12T00:00:00.000Z',
            updatedAt: '2026-03-12T00:00:01.000Z',
          },
        };
      }
      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });

    try {
      process.env.CLAUDE_TEAM_CONTROL_URL = server.baseUrl;
      writeControlApiState(claudeDir, 'http://127.0.0.1:1');

      const launched = await controller.runtime.launchTeam({
        cwd: '/tmp/project',
      });

      expect(launched.runId).toBe('run-env');
      expect(launched.progress.state).toBe('ready');
    } finally {
      if (previousUrl === undefined) {
        delete process.env.CLAUDE_TEAM_CONTROL_URL;
      } else {
        process.env.CLAUDE_TEAM_CONTROL_URL = previousUrl;
      }
      await server.close();
    }
  });

  it('falls back to the next control endpoint when the first one responds with 404', async () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const previousUrl = process.env.CLAUDE_TEAM_CONTROL_URL;

    const staleServer = await startControlServer(async () => {
      return { statusCode: 404, body: { error: 'Not found' } };
    });
    const liveServer = await startControlServer(async ({ method, url }) => {
      if (method === 'POST' && url === '/api/teams/my-team/launch') {
        return { body: { runId: 'run-live' } };
      }
      if (method === 'GET' && url === '/api/teams/provisioning/run-live') {
        return {
          body: {
            runId: 'run-live',
            teamName: 'my-team',
            state: 'ready',
            message: 'Ready',
            startedAt: '2026-03-12T00:00:00.000Z',
            updatedAt: '2026-03-12T00:00:01.000Z',
          },
        };
      }
      return { statusCode: 404, body: { error: `Unhandled ${method} ${url}` } };
    });

    try {
      writeControlApiState(claudeDir, staleServer.baseUrl);
      process.env.CLAUDE_TEAM_CONTROL_URL = liveServer.baseUrl;

      const launched = await controller.runtime.launchTeam({
        cwd: '/tmp/project',
      });

      expect(launched.runId).toBe('run-live');
      expect(launched.progress.state).toBe('ready');
    } finally {
      if (previousUrl === undefined) {
        delete process.env.CLAUDE_TEAM_CONTROL_URL;
      } else {
        process.env.CLAUDE_TEAM_CONTROL_URL = previousUrl;
      }
      await staleServer.close();
      await liveServer.close();
    }
  });

  describe('lookupMessage', () => {
    it('finds a message by exact messageId from sentMessages', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      const sent = controller.messages.appendSentMessage({
        from: 'team-lead',
        to: 'bob',
        text: 'Please check the logs',
        source: 'user_sent',
      });

      const result = controller.messages.lookupMessage(sent.messageId);

      expect(result.message.messageId).toBe(sent.messageId);
      expect(result.message.text).toBe('Please check the logs');
      expect(result.store).toBe('sent');
    });

    it('finds a message by exact messageId from inbox', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      const delivered = controller.messages.sendMessage({
        to: 'bob',
        from: 'user',
        text: 'Deploy to staging',
        source: 'inbox',
      });

      const result = controller.messages.lookupMessage(delivered.messageId);

      expect(result.message.messageId).toBe(delivered.messageId);
      expect(result.message.text).toBe('Deploy to staging');
      expect(result.store).toBe('inbox:bob');
    });

    it('throws on unknown messageId', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      expect(() => controller.messages.lookupMessage('nonexistent-id')).toThrow(
        'Message not found: nonexistent-id'
      );
    });

    it('throws on missing messageId', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      expect(() => controller.messages.lookupMessage('')).toThrow('Missing messageId');
    });

    it('does not match by relayOfMessageId', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      controller.messages.sendMessage({
        to: 'bob',
        from: 'team-lead',
        text: 'Relayed message',
        relayOfMessageId: 'original-msg-123',
        source: 'system_notification',
      });

      // The relayOfMessageId should NOT be found as a direct messageId match
      expect(() => controller.messages.lookupMessage('original-msg-123')).toThrow(
        'Message not found: original-msg-123'
      );
    });

    it('rejects ambiguous messageId found in multiple stores', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      // Manually write same messageId to both sent and inbox
      const sentPath = path.join(claudeDir, 'teams', 'my-team', 'sentMessages.json');
      const inboxDir = path.join(claudeDir, 'teams', 'my-team', 'inboxes');
      fs.mkdirSync(inboxDir, { recursive: true });
      const inboxPath = path.join(inboxDir, 'bob.json');

      const dupeId = 'dupe-message-id';
      fs.writeFileSync(sentPath, JSON.stringify([{ messageId: dupeId, text: 'copy-1' }]));
      fs.writeFileSync(inboxPath, JSON.stringify([{ messageId: dupeId, text: 'copy-2' }]));

      expect(() => controller.messages.lookupMessage(dupeId)).toThrow(
        'Ambiguous messageId: dupe-message-id found in multiple stores'
      );
    });
  });
});
