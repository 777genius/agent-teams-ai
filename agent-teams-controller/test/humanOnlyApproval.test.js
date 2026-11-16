const fs = require('fs');
const os = require('os');
const path = require('path');
const { createController } = require('../src/index.js');

describe('human-only review approval', () => {
  let dir;
  let board;
  let controller;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-only-review-'));
    const teamDir = path.join(dir, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify({
      name: 'fixture', leadSessionId: 'lead-session-1',
      members: [{ name: 'alice', role: 'team-lead' }, { name: 'bob', role: 'developer' }],
    }));
    controller = createController({ teamName: 'fixture', claudeDir: dir });
    board = controller.taskBoard;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const taskFile = (id) => path.join(dir, 'tasks', 'fixture', id + '.json');
  const kanbanFile = () => path.join(dir, 'teams', 'fixture', 'kanban-state.json');
  const events = (id, type) => board.getTask(id).historyEvents.filter((e) => e.type === type);

  it('keeps opt-in disabled and preserves the existing agent approval workflow', () => {
    const task = board.createTask({ subject: 'Legacy approval', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    expect(board.getKanbanState().humanOnlyApproval).toBe(false);
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    board.approveReview(task.id, { from: 'alice' });
    expect(board.getTask(task.id).reviewState).toBe('approved');
    expect(events(task.id, 'review_approved')).toHaveLength(1);
  });

  it('closes only the requested cycle to reviewed Done and allows human acceptance', () => {
    const task = board.createTask({ subject: 'Require human acceptance', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setHumanOnlyApproval(true);
    board.addReviewer('alice');
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });

    const cycle = events(task.id, 'review_requested')[0].id;
    expect(board.startReview(task.id, { from: 'alice' }).reviewRequestId).toBe(cycle);
    const inbox = JSON.parse(fs.readFileSync(
      path.join(dir, 'teams', 'fixture', 'inboxes', 'alice.json'), 'utf8'
    ));
    expect(inbox.some((msg) => msg.text.includes(cycle) && msg.text.includes('review_complete'))).toBe(true);
    expect(() => board.approveReview(task.id, { from: 'alice' })).toThrow(/Human approval required/);
    expect(() => board.setKanbanColumn(task.id, 'approved', { transition: 'manual_approve' }))
      .toThrow(/Human approval required/);

    const complete = board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
    expect(complete).toMatchObject({ ok: true, column: 'done', reviewState: 'reviewed', alreadyCompleted: false });
    expect(board.getTask(task.id).reviewState).toBe('reviewed');
    expect(board.getKanbanState().tasks[task.id]).toBeUndefined();
    expect(events(task.id, 'review_completed')).toHaveLength(1);
    const afterFirst = fs.readFileSync(taskFile(task.id), 'utf8');
    const again = board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
    expect(again.alreadyCompleted).toBe(true);
    expect(fs.readFileSync(taskFile(task.id), 'utf8')).toBe(afterFirst);

    const approved = board.approveAsHuman(task.id);
    expect(approved.reviewState).toBe('approved');
    expect(board.getKanbanState().tasks[task.id].column).toBe('approved');
    expect(events(task.id, 'human_approved')).toHaveLength(1);
    expect(board.approveAsHuman(task.id).reviewState).toBe('approved');
    expect(events(task.id, 'human_approved')).toHaveLength(1);
    const retryAfterHumanApproval = board.completeReview(task.id, {
      from: 'alice', expectedReviewRequestId: cycle,
    });
    expect(retryAfterHumanApproval).toMatchObject({
      alreadyCompleted: true, column: 'approved', reviewState: 'approved',
    });
    expect(events(task.id, 'review_completed')).toHaveLength(1);
  });

  it('rejects stale, absent, wrong-reviewer and superseded cycle IDs without mutation', () => {
    const task = board.createTask({ subject: 'Stale cycle', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setHumanOnlyApproval(true);
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const cycle = events(task.id, 'review_requested')[0].id;
    const beforeTask = fs.readFileSync(taskFile(task.id), 'utf8');
    const beforeKanban = fs.readFileSync(kanbanFile(), 'utf8');
    expect(() => board.completeReview(task.id, { from: 'alice' })).toThrow(/expectedReviewRequestId/);
    expect(() => board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: 'wrong-id' }))
      .toThrow(/Stale review request/);
    expect(() => board.completeReview(task.id, { from: 'bob', expectedReviewRequestId: cycle }))
      .toThrow(/assigned to reviewer/);
    expect(fs.readFileSync(taskFile(task.id), 'utf8')).toBe(beforeTask);
    expect(fs.readFileSync(kanbanFile(), 'utf8')).toBe(beforeKanban);

    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const nextCycle = events(task.id, 'review_requested').at(-1).id;
    expect(nextCycle).not.toBe(cycle);
    expect(() => board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle }))
      .toThrow(/Stale review request/);
    expect(board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: nextCycle }).ok)
      .toBe(true);
    board.startTask(task.id, 'bob');
    expect(() => board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: nextCycle }))
      .toThrow(/Stale review request/);
  });

  it('lets only the trusted human path request changes from reviewed Done', () => {
    const task = board.createTask({ subject: 'Human rejects AI review', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setHumanOnlyApproval(true);
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const cycle = events(task.id, 'review_requested')[0].id;
    board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
    expect(() => board.requestChanges(task.id, { from: 'alice', comment: 'Fix this' }))
      .toThrow(/must be in review/);
    const changed = board.requestChangesAsHuman(task.id, { comment: 'Needs a fix' });
    expect(changed).toMatchObject({ status: 'pending', reviewState: 'needsFix' });
    expect(events(task.id, 'review_changes_requested').at(-1)).toMatchObject({
      from: 'reviewed', to: 'needsFix', actor: 'user',
    });
    expect(() => board.requestChangesAsHuman(task.id, { comment: 'Again' }))
      .toThrow(/Human rejection requires/);
  });

  it('preserves settings through kanban writes and fails closed for corrupt stored policy', () => {
    board.addReviewer('alice');
    board.setHumanOnlyApproval(true);
    board.removeReviewer('alice');
    expect(board.getKanbanState().humanOnlyApproval).toBe(true);
    const disk = JSON.parse(fs.readFileSync(kanbanFile(), 'utf8'));
    expect(disk.humanOnlyApproval).toBe(true);
    disk.humanOnlyApproval = 'true';
    fs.writeFileSync(kanbanFile(), JSON.stringify(disk));
    expect(() => board.getKanbanState()).toThrow(/policy is corrupt/);
    expect(() => board.setHumanOnlyApproval(false)).toThrow(/policy is corrupt/);
  });

  it('allows explicit AI-only completion when default policy is off', () => {
    const task = board.createTask({ subject: 'Normal policy task', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const cycle = events(task.id, 'review_requested')[0].id;
    expect(board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle })).toMatchObject({
      ok: true, column: 'done', reviewState: 'reviewed',
    });
    expect(board.getTask(task.id).reviewState).toBe('reviewed');
  });
});
