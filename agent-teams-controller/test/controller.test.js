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

  it('keeps assigned tasks pending by default, supports explicit immediate start, notifies owners, and groups briefing by review-aware sections', async () => {
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
    expect(briefing).toContain('In progress:');
    expect(briefing).toContain(`#${activeTask.displayId}`);
    expect(briefing).toContain('Description: Resume immediately');
    expect(briefing).toContain('Resumed work with latest context.');
    expect(briefing).toContain('Needs fixes after review:');
    expect(briefing).toContain(`#${needsFixTask.displayId}`);
    expect(briefing).toContain('Pending:');
    expect(briefing).toContain(`#${pendingTask.displayId}`);
    expect(briefing).not.toContain('Description: Do this later');
    expect(briefing).toContain('Review:');
    expect(briefing).toContain(`#${reviewTask.displayId}`);
    expect(briefing).toContain('Completed:');
    expect(briefing).toContain(`#${completedTask.displayId}`);
    expect(briefing).not.toContain(
      'Completed task description should stay out of compact rows'
    );
    expect(briefing).toContain('Approved (last 10):');
    expect(briefing).toContain(`#${approvedTask.displayId}`);
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

  it('persists full inbox metadata through controller messages.sendMessage', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const sent = controller.messages.sendMessage({
      to: 'bob',
      from: 'team-lead',
      text: 'Need your review',
      summary: 'Review request',
      relayOfMessageId: 'm-original-1',
      source: 'system_notification',
      leadSessionId: 'session-42',
      attachments: [{ id: 'a1', filename: 'note.txt', mimeType: 'text/plain', size: 7 }],
    });

    expect(sent.deliveredToInbox).toBe(true);
    expect(sent.messageId).toBeTruthy();

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('system_notification');
    expect(rows[0].relayOfMessageId).toBe('m-original-1');
    expect(rows[0].leadSessionId).toBe('session-42');
    expect(rows[0].attachments[0].filename).toBe('note.txt');
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

  it('does not wake owner for self-comments and clears user clarification when user replies', () => {
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

    expect(replied.task.needsClarification).toBeUndefined();
    const reloaded = controller.tasks.getTask(task.id);
    expect(reloaded.needsClarification).toBeUndefined();
    const rows = JSON.parse(fs.readFileSync(ownerInboxPath, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain('Please use the safer option.');
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
      from: 'alice',
      text: 'Need your decision here.',
    });

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'team-lead.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe('alice');
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

  it('limits approved briefing section to the latest 10 tasks by freshness', async () => {
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
    expect(briefing).toContain('Approved (last 10):');
    expect(briefing).toContain(`#${approvedTasks[11].displayId}`);
    expect(briefing).toContain(`#${approvedTasks[2].displayId}`);
    expect(briefing).not.toContain(`#${approvedTasks[1].displayId}`);
    expect(briefing).not.toContain(`#${approvedTasks[0].displayId}`);
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
});
