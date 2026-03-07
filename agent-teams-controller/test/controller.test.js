const fs = require('fs');
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
              `Comment on task #${task.displayId} "Ship migration":\n\nHeads up\n\n` +
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

  it('derives reviewState from legacy kanban overlay and tolerates corrupt kanban state', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Legacy review task' });
    const taskPath = path.join(claudeDir, 'tasks', 'my-team', `${task.id}.json`);
    const rawTask = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    delete rawTask.reviewState;
    fs.writeFileSync(taskPath, JSON.stringify(rawTask, null, 2));

    const kanbanPath = path.join(claudeDir, 'teams', 'my-team', 'kanban-state.json');
    fs.writeFileSync(
      kanbanPath,
      JSON.stringify(
        {
          teamName: 'my-team',
          reviewers: [],
          tasks: {
            [task.id]: { column: 'review', movedAt: '2026-01-01T00:00:00.000Z', reviewer: null },
          },
        },
        null,
        2
      )
    );

    expect(controller.tasks.getTask(task.id).reviewState).toBe('review');
    expect(controller.tasks.listTasks()[0].reviewState).toBe('review');

    fs.writeFileSync(kanbanPath, '{broken-json');
    expect(controller.tasks.getTask(task.id).reviewState).toBe('none');
    expect(controller.tasks.listTasks()[0].reviewState).toBe('none');
  });

  it('tracks lifecycle history and intervals without duplicate same-status transitions', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Lifecycle task' });

    expect(task.status).toBe('pending');
    expect(task.statusHistory).toHaveLength(1);
    expect(task.workIntervals).toBeUndefined();

    const started = controller.tasks.startTask(task.id, 'bob');
    const startedAgain = controller.tasks.startTask(task.id, 'bob');
    const completed = controller.tasks.completeTask(task.id, 'bob');
    const completedAgain = controller.tasks.completeTask(task.id, 'bob');
    const deleted = controller.tasks.softDeleteTask(task.id, 'bob');
    const restored = controller.tasks.restoreTask(task.id, 'bob');

    expect(started.status).toBe('in_progress');
    expect(startedAgain.statusHistory).toHaveLength(2);
    expect(startedAgain.workIntervals).toHaveLength(1);
    expect(startedAgain.workIntervals[0].startedAt).toBeTruthy();

    expect(completed.status).toBe('completed');
    expect(completedAgain.statusHistory).toHaveLength(3);
    expect(completedAgain.workIntervals).toHaveLength(1);
    expect(completedAgain.workIntervals[0].completedAt).toBeTruthy();

    expect(deleted.status).toBe('deleted');
    expect(deleted.deletedAt).toBeTruthy();
    expect(restored.status).toBe('pending');
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.statusHistory).toHaveLength(5);
    expect(restored.statusHistory.map((entry) => entry.to)).toEqual([
      'pending',
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
  });

  it('persists full inbox metadata through controller messages.sendMessage', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const sent = controller.messages.sendMessage({
      to: 'bob',
      from: 'team-lead',
      text: 'Need your review',
      summary: 'Review request',
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
    expect(rows[0].leadSessionId).toBe('session-42');
    expect(rows[0].attachments[0].filename).toBe('note.txt');
  });

  it('moves review back to in_progress and notifies owner on requestChanges', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Needs revision', owner: 'bob' });

    controller.tasks.completeTask(task.id, 'bob');
    controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const updated = controller.review.requestChanges(task.id, {
      from: 'alice',
      comment: 'Please address review feedback.',
    });

    expect(updated.status).toBe('in_progress');
    expect(updated.reviewState).toBe('none');
    expect(updated.comments.at(-1).type).toBe('review_request');

    const inboxPath = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    expect(rows.at(-1).source).toBe('system_notification');
    expect(rows.at(-1).summary).toContain('Fix request');
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
});
