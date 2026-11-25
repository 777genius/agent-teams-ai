const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

describe('atomic human clarification answers', () => {
  let claudeDir;
  let controller;

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-answer-'));
    fs.mkdirSync(path.join(claudeDir, 'teams', 'test-team'), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'tasks', 'test-team'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'teams', 'test-team', 'config.json'),
      JSON.stringify({ name: 'test-team', leadSessionId: 'lead-session', members: [
        { name: 'alice', role: 'team-lead' }, { name: 'bob', role: 'developer' },
      ] }));
    controller = createController({ teamName: 'test-team', claudeDir });
  });

  afterEach(() => {
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  function readTask(taskId) {
    return JSON.parse(fs.readFileSync(
      path.join(claudeDir, 'tasks', 'test-team', taskId + '.json'), 'utf8'));
  }

  function commentNotices() {
    const file = path.join(claudeDir, 'teams', 'test-team', 'inboxes', 'bob.json');
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8'))
      .filter((item) => item.source === 'system_notification' &&
        String(item.text).includes('Use PostgreSQL'));
  }

  it('writes a user comment and clears only the matching request in one task update', () => {
    const task = controller.tasks.createTask({
      subject: 'Choose database', owner: 'bob', status: 'pending', notifyOwner: false,
      needsClarification: 'user',
    });
    const initial = readTask(task.id);
    expect(initial.clarificationRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    const answer = {
      from: 'user', text: 'Use PostgreSQL',
      answerClarificationRequestId: initial.clarificationRequestId,
    };
    const first = controller.tasks.addTaskComment(task.id, answer);
    const persisted = readTask(task.id);
    expect(persisted.comments).toHaveLength(1);
    expect(persisted.comments[0]).toMatchObject({
      id: 'clarification-answer-' + initial.clarificationRequestId,
      author: 'user', text: answer.text,
    });
    expect(persisted.needsClarification).toBeUndefined();
    expect(persisted.clarificationRequestedAt).toBeUndefined();
    expect(persisted.clarificationRequestId).toBeUndefined();
    expect(persisted.status).toBe('pending');
    expect(first.commentId).toBe(persisted.comments[0].id);

    const noticesBefore = commentNotices().length;
    const second = controller.tasks.addTaskComment(task.id, answer);
    expect(second.commentId).toBe(first.commentId);
    expect(readTask(task.id)).toEqual(persisted);
    expect(commentNotices()).toHaveLength(noticesBefore);
    expect(() => controller.tasks.addTaskComment(task.id, {
      ...answer, text: 'Use SQLite instead',
    })).toThrow('different content');
  });

  it('retries normalized answer references and attachments without accepting changed content', () => {
    const task = controller.tasks.createTask({
      subject: 'Choose database', owner: 'bob', notifyOwner: false, needsClarification: 'user',
    });
    const taskRef = { taskId: 'related-task', displayId: 'related', teamName: 'test-team' };
    const attachment = {
      id: 'answer-evidence', filename: 'evidence.txt', mimeType: 'text/plain', size: 42,
      createdAt: '2026-11-24T00:00:00.000Z',
    };
    const answer = {
      from: 'user', text: 'Use PostgreSQL',
      answerClarificationRequestId: readTask(task.id).clarificationRequestId,
      taskRefs: [{ ...taskRef, taskId: ' related-task ', teamName: ' test-team ' }],
      attachments: [attachment],
    };
    const first = controller.tasks.addTaskComment(task.id, answer);
    const persisted = readTask(task.id);
    expect(persisted.comments[0].taskRefs).toEqual([taskRef]);

    const retried = controller.tasks.addTaskComment(task.id, {
      ...answer,
      taskRefs: [taskRef],
      attachments: [{ ...attachment, createdAt: '2026-11-25T00:00:00.000Z' }],
    });
    expect(retried.commentId).toBe(first.commentId);
    expect(readTask(task.id)).toEqual(persisted);

    for (const changedContent of [
      { taskRefs: [{ ...taskRef, taskId: 'another-task' }] },
      { attachments: [{ ...attachment, size: 43 }] },
    ]) {
      expect(() => controller.tasks.addTaskComment(task.id, {
        ...answer, ...changedContent,
      })).toThrow('Clarification already answered with different content');
      expect(readTask(task.id)).toEqual(persisted);
    }
  });

  it('does not let an old answer close a new clarification cycle', () => {
    const task = controller.tasks.createTask({ subject: 'Pick option', owner: 'bob', notifyOwner: false });
    controller.tasks.setNeedsClarification(task.id, 'user');
    const first = readTask(task.id).clarificationRequestId;
    controller.tasks.setNeedsClarification(task.id, 'user');
    expect(readTask(task.id).clarificationRequestId).toBe(first);
    controller.tasks.addTaskComment(task.id, {
      from: 'user', text: 'Use PostgreSQL', answerClarificationRequestId: first,
    });
    controller.tasks.setNeedsClarification(task.id, 'user');
    const second = readTask(task.id).clarificationRequestId;
    expect(second).not.toBe(first);
    const before = readTask(task.id);
    expect(() => controller.tasks.addTaskComment(task.id, {
      from: 'user', text: 'Use PostgreSQL', answerClarificationRequestId: first,
    })).toThrow('request changed');
    expect(readTask(task.id)).toEqual(before);
    controller.tasks.addTaskComment(task.id, {
      from: 'user', text: 'Choose PostgreSQL again', answerClarificationRequestId: second,
    });
    expect(readTask(task.id).needsClarification).toBeUndefined();
  });

  it('rejects forged, wrong-task and malformed answers, but leaves ordinary comments alone', () => {
    const task = controller.tasks.createTask({ subject: 'Review', owner: 'bob', notifyOwner: false });
    const another = controller.tasks.createTask({ subject: 'Other', owner: 'bob', notifyOwner: false });
    controller.tasks.setNeedsClarification(task.id, 'user');
    controller.tasks.setNeedsClarification(another.id, 'user');
    const requestId = readTask(task.id).clarificationRequestId;
    controller.tasks.addTaskComment(task.id, { from: 'user', text: 'A normal note' });
    expect(readTask(task.id).needsClarification).toBe('user');
    const beforeOther = readTask(another.id);

    expect(() => controller.tasks.addTaskComment(another.id, {
      from: 'user', text: 'Wrong task', answerClarificationRequestId: requestId,
    })).toThrow('request changed');
    expect(readTask(another.id)).toEqual(beforeOther);
    expect(() => controller.tasks.addTaskComment(task.id, {
      from: 'user', text: 'Malformed', answerClarificationRequestId: 'not-a-uuid',
    })).toThrow('Invalid task clarification answer identity');
    expect(() => controller.tasks.addTaskComment(task.id, {
      from: 'bob', text: 'Agent cannot impersonate user',
      answerClarificationRequestId: requestId,
    })).toThrow('Only the user');

    const agentController = createController({
      teamName: 'test-team', claudeDir, allowUserMessageSender: false,
    });
    expect(() => agentController.tasks.addTaskComment(task.id, {
      from: 'user', text: 'Forged agent answer', answerClarificationRequestId: requestId,
    })).toThrow();
    expect(readTask(task.id).needsClarification).toBe('user');
  });

  it('never binds legacy unversioned requests by guessing a timestamp', () => {
    const task = controller.tasks.createTask({ subject: 'Legacy', notifyOwner: false });
    controller.tasks.setNeedsClarification(task.id, 'user');
    const file = path.join(claudeDir, 'tasks', 'test-team', task.id + '.json');
    const legacy = readTask(task.id);
    delete legacy.clarificationRequestId;
    fs.writeFileSync(file, JSON.stringify(legacy));
    controller.tasks.setNeedsClarification(task.id, 'user');
    expect(readTask(task.id).clarificationRequestId).toBeUndefined();
    expect(() => controller.tasks.addTaskComment(task.id, {
      from: 'user', text: 'Guessing not permitted',
      answerClarificationRequestId: crypto.randomUUID(),
    })).toThrow('request changed');
    expect(readTask(task.id).needsClarification).toBe('user');
  });
});
