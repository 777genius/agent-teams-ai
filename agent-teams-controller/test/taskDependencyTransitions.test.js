const fs = require('fs');
const os = require('os');
const path = require('path');
const { createController } = require('../src/index.js');

const transitions = [
  ['start', 'in_progress', (tasks, id) => tasks.startTask(id, 'bob')],
  ['complete', 'completed', (tasks, id) => tasks.completeTask(id, 'bob')],
  ['set in_progress', 'in_progress', (tasks, id) => tasks.setTaskStatus(id, 'in_progress', 'bob')],
  ['set completed', 'completed', (tasks, id) => tasks.setTaskStatus(id, 'completed', 'bob')],
];

describe('issue-618 dependency transitions', () => {
  let dir;
  let tasks;
  let sequence = 0;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue618-controller-'));
    fs.mkdirSync(path.join(dir, 'teams', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'teams', 'fixture', 'config.json'), JSON.stringify({
      name: 'fixture', members: [{ name: 'alice', role: 'team-lead' }, { name: 'bob', role: 'developer' }],
    }));
    tasks = createController({ teamName: 'fixture', claudeDir: dir }).taskBoard;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir, { recursive: true })
    .filter((file) => fs.statSync(path.join(dir, file)).isFile())
    .map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]));
  const create = (blockedBy = []) => tasks.createTask({ subject: `Fixture task ${++sequence}`, owner: 'bob', blockedBy });
  const inbox = (owner) => {
    const file = path.join(dir, 'teams', 'fixture', 'inboxes', `${owner}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  };
  const rewrite = (task, patch) => {
    const file = path.join(dir, 'tasks', 'fixture', `${task.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
  };

  describe.each(transitions)('%s', (_name, status, transition) => {
    it.each(['pending', 'in_progress'])('refuses %s blockers without changing any fixture file', (blockerStatus) => {
      const blocker = create();
      tasks.setTaskStatus(blocker.id, blockerStatus, 'bob');
      const dependent = create([blocker.id]);
      // Include kanban and already-inconsistent protected states in the snapshot.
      rewrite(dependent, { status });
      fs.writeFileSync(path.join(dir, 'teams', 'fixture', 'kanban-state.json'), JSON.stringify({
        tasks: { [dependent.id]: { column: 'review' } }, columnOrder: { review: [dependent.id] },
      }));
      const before = snapshot();
      expect(() => transition(tasks, dependent.id)).toThrow(`to ${status}: unresolved dependencies #${blocker.displayId} (${blockerStatus})`);
      expect(snapshot()).toEqual(before);
    });

    it.each(['completed', 'deleted', 'missing', 'empty'])('allows %s dependencies', (resolution) => {
      const blocker = create();
      const dependent = create(resolution === 'empty' ? [] : [blocker.id]);
      if (resolution === 'completed' || resolution === 'deleted') tasks.setTaskStatus(blocker.id, resolution, 'bob');
      if (resolution === 'missing') fs.unlinkSync(path.join(dir, 'tasks', 'fixture', `${blocker.id}.json`));
      expect(transition(tasks, dependent.id).status).toBe(status);
    });

    it('lists only remaining open blockers', () => {
      const first = create();
      const second = create();
      const dependent = create([first.id, second.id]);
      tasks.completeTask(first.id, 'bob');
      const before = snapshot();
      let error;
      try { transition(tasks, dependent.id); } catch (caught) { error = caught; }
      expect(error.message).toContain(`#${second.displayId} (pending)`);
      expect(error.message).not.toContain(`#${first.displayId}`);
      expect(snapshot()).toEqual(before);
    });
  });

  it('preserves administrative transitions, restore and owner checks', () => {
    const blocker = create();
    const dependent = create([blocker.id]);
    tasks = createController({ teamName: 'fixture', claudeDir: dir, allowUserMessageSender: false }).taskBoard;
    expect(() => tasks.startTask(dependent.id, 'alice')).toThrow(/owned/i);
    expect(() => tasks.completeTask(dependent.id, 'alice')).toThrow(/owned/i);
    expect(() => tasks.setTaskStatus(dependent.id, 'completed', 'alice')).toThrow(/owned/i);
    expect(tasks.setTaskStatus(dependent.id, 'pending', 'alice').status).toBe('pending');
    expect(tasks.setTaskStatus(dependent.id, 'deleted', 'alice').status).toBe('deleted');
    expect(() => tasks.startTask(dependent.id, 'bob')).toThrow(/deleted/);
    expect(tasks.restoreTask(dependent.id, 'alice').status).toBe('pending');
    expect(() => tasks.startTask(dependent.id, 'bob')).toThrow(/unresolved dependencies/);
  });

  it.each(['complete', 'set completed'])('%s preserves partial/final notices and retry deduplication', (method) => {
    const finish = method === 'complete' ? transitions[1][2] : transitions[3][2];
    const first = create();
    const second = create();
    const dependent = create([first.id, second.id]);
    tasks.startTask(first.id, 'bob');
    finish(tasks, first.id);
    const partial = tasks.getTask(dependent.id).comments;
    expect(partial).toHaveLength(1);
    expect(partial[0].text).toContain('Still waiting on:');
    expect(partial[0].text).not.toContain('task_start');
    tasks.startTask(second.id, 'bob');
    finish(tasks, second.id);
    const completed = tasks.getTask(second.id);
    finish(tasks, second.id);
    tasks.completeTask(second.id, 'bob');
    tasks.setTaskStatus(second.id, 'completed', 'bob');
    expect(tasks.getTask(second.id).historyEvents).toEqual(completed.historyEvents);
    expect(tasks.getTask(second.id).workIntervals).toEqual(completed.workIntervals);
    const comments = tasks.getTask(dependent.id).comments;
    expect(comments).toHaveLength(2);
    expect(comments[1].text).toContain('task_get');
    expect(comments[1].text).toContain('task_start');
    expect(inbox('bob').filter((row) => row.text.includes('Dependency resolved'))).toHaveLength(2);
    expect(inbox('alice').filter((row) => row.text.includes('Dependency resolved'))).toHaveLength(0);
    tasks.startTask(dependent.id, 'bob');
    finish(tasks, dependent.id);
    tasks.completeTask(dependent.id, 'bob');
    tasks.setTaskStatus(dependent.id, 'completed', 'bob');
    expect(inbox('alice').filter((row) => String(row.messageId).startsWith('board-complete:'))).toHaveLength(1);
    tasks.setTaskStatus(second.id, 'deleted', 'bob');
    expect(tasks.getTask(dependent.id).comments).toEqual(comments);
  });
});
