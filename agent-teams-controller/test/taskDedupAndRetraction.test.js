const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

describe('task_create dedup and delete-time notification retraction', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeClaudeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-controller-'));
    tempDirs.push(dir);
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

  function getInboxPath(claudeDir, memberName) {
    return path.join(claudeDir, 'teams', 'my-team', 'inboxes', `${memberName}.json`);
  }

  function readInbox(claudeDir, memberName) {
    const inboxPath = getInboxPath(claudeDir, memberName);
    if (!fs.existsSync(inboxPath)) return [];
    return JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
  }

  function writeInbox(claudeDir, memberName, rows) {
    fs.mkdirSync(path.dirname(getInboxPath(claudeDir, memberName)), { recursive: true });
    fs.writeFileSync(getInboxPath(claudeDir, memberName), JSON.stringify(rows, null, 2));
  }

  describe('task_create content dedup', () => {
    it('returns the existing task when the same content is replayed within the window', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      const first = controller.tasks.createTask({
        subject: 'Ship feature',
        owner: 'bob',
        from: 'alice',
      });
      const replayed = controller.tasks.createTask({
        subject: '  ship FEATURE ',
        owner: 'bob',
        from: 'alice',
      });

      expect(replayed.id).toBe(first.id);
      expect(controller.tasks.listTasks()).toHaveLength(1);

      const assignments = readInbox(claudeDir, 'bob').filter((row) =>
        row.text.includes('New task assigned to you:')
      );
      expect(assignments).toHaveLength(1);
    });

    // An explicit creation command id is the caller's own dedup key, so identical content
    // under two different ids stays two tasks while keyless creates keep content dedup.
    const buildCommandInput = (id, idempotencyKey) => ({
      id,
      subject: 'Replayed command task',
      owner: 'bob',
      from: 'alice',
      creationCommand: {
        namespace: 'task-board',
        scopeKey: 'my-team',
        operation: 'task.create',
        commandId: id,
        payloadHash: 'sha256:payload',
        idempotencyKey,
      },
    });

    it('keeps creates with differing explicit command identities distinct', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });
      const firstId = '11111111-1111-4111-8111-111111111111';
      const secondId = '22222222-2222-4222-8222-222222222222';

      const first = controller.tasks.createTask(buildCommandInput(firstId, 'request-key-a'));
      const second = controller.tasks.createTask(buildCommandInput(secondId, 'request-key-b'));

      expect(first.id).toBe(firstId);
      expect(second.id).toBe(secondId);
      expect(controller.tasks.listTasks()).toHaveLength(2);
      expect(readInbox(claudeDir, 'bob')).toHaveLength(2);
    });

    it('collapses a replay of the same explicit command identity', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });
      const commandId = '33333333-3333-4333-8333-333333333333';
      const input = buildCommandInput(commandId, 'request-key-a');

      const first = controller.tasks.createTask(input);
      expect(() => controller.tasks.createTask(input)).toThrow(`Task already exists: ${commandId}`);
      const replayed = controller.tasks.reconcileTaskCreation(input);

      expect(replayed.id).toBe(first.id);
      expect(controller.tasks.listTasks()).toHaveLength(1);
      expect(readInbox(claudeDir, 'bob')).toHaveLength(1);
    });

    it('still content-dedups a keyless create against an explicitly keyed task', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });
      const commandId = '44444444-4444-4444-8444-444444444444';

      const keyed = controller.tasks.createTask(buildCommandInput(commandId, 'request-key-a'));
      const keyless = controller.tasks.createTask({
        subject: 'Replayed command task',
        owner: 'bob',
        from: 'alice',
      });

      expect(keyless.id).toBe(keyed.id);
      expect(controller.tasks.listTasks()).toHaveLength(1);
      expect(readInbox(claudeDir, 'bob')).toHaveLength(1);
    });

    it('creates a new task when the subject differs', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      const first = controller.tasks.createTask({
        subject: 'Ship feature',
        owner: 'bob',
        from: 'alice',
      });
      const second = controller.tasks.createTask({
        subject: 'Ship feature docs',
        owner: 'bob',
        from: 'alice',
      });

      expect(second.id).not.toBe(first.id);
      expect(controller.tasks.listTasks()).toHaveLength(2);
    });

    it('creates a new task when the matching task is older than the dedup window', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      const stale = controller.tasks.createTask({
        subject: 'Ship feature',
        owner: 'bob',
        from: 'alice',
        createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      });
      const fresh = controller.tasks.createTask({
        subject: 'Ship feature',
        owner: 'bob',
        from: 'alice',
      });

      expect(fresh.id).not.toBe(stale.id);
      expect(controller.tasks.listTasks()).toHaveLength(2);
    });

    it('does not dedup against completed or deleted tasks', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      const completed = controller.tasks.createTask({
        subject: 'Done work',
        owner: 'bob',
        from: 'alice',
      });
      controller.tasks.completeTask(completed.id, 'bob');
      const afterCompleted = controller.tasks.createTask({
        subject: 'Done work',
        owner: 'bob',
        from: 'alice',
      });
      expect(afterCompleted.id).not.toBe(completed.id);

      controller.tasks.softDeleteTask(afterCompleted.id, 'alice');
      const afterDeleted = controller.tasks.createTask({
        subject: 'Done work',
        owner: 'bob',
        from: 'alice',
      });
      expect(afterDeleted.id).not.toBe(afterCompleted.id);
    });
  });

  describe('delete-time notification retraction', () => {
    it('retracts unread system notifications for a task deleted via task_set_status', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      const task = controller.tasks.createTask({
        subject: 'Doomed task',
        owner: 'bob',
        from: 'alice',
      });

      const rows = readInbox(claudeDir, 'bob');
      expect(rows).toHaveLength(1);
      rows.push(
        {
          from: 'alice',
          to: 'bob',
          text: 'Unrelated coordination ping',
          timestamp: new Date().toISOString(),
          read: false,
          messageId: 'keep-regular',
        },
        {
          from: 'alice',
          to: 'bob',
          text: `Already seen note about #${task.displayId}`,
          timestamp: new Date().toISOString(),
          read: true,
          source: 'system_notification',
          taskRefs: [{ taskId: task.id, displayId: task.displayId, teamName: 'my-team' }],
          messageId: 'keep-read',
        },
        {
          from: 'alice',
          to: 'bob',
          summary: `Heads up on #${task.displayId}`,
          text: `Queued follow-up referencing #${task.displayId} without taskRefs`,
          timestamp: new Date().toISOString(),
          read: false,
          source: 'system_notification',
          messageId: 'drop-display-ref',
        }
      );
      writeInbox(claudeDir, 'bob', rows);

      const deleted = controller.tasks.setTaskStatus(task.id, 'deleted', 'alice');
      expect(deleted.status).toBe('deleted');

      const remaining = readInbox(claudeDir, 'bob');
      expect(remaining.map((row) => row.messageId)).toEqual(['keep-regular', 'keep-read']);
    });

    it('retracts assignment and comment notifications on softDeleteTask and leaves other inboxes intact', () => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });

      const doomed = controller.tasks.createTask({
        subject: 'Task for bob',
        owner: 'bob',
        from: 'alice',
      });
      const unrelated = controller.tasks.createTask({
        subject: 'Task for alice',
        owner: 'alice',
        from: 'bob',
      });
      controller.tasks.addTaskComment(doomed.id, {
        text: 'How is it going?',
        from: 'alice',
      });

      expect(readInbox(claudeDir, 'bob')).toHaveLength(2);
      expect(readInbox(claudeDir, 'alice')).toHaveLength(1);

      const deleted = controller.tasks.softDeleteTask(doomed.id, 'alice');
      expect(deleted.status).toBe('deleted');

      expect(readInbox(claudeDir, 'bob')).toHaveLength(0);
      const aliceRows = readInbox(claudeDir, 'alice');
      expect(aliceRows).toHaveLength(1);
      expect(aliceRows[0].summary).toContain(`#${unrelated.displayId}`);
    });
  });
});
