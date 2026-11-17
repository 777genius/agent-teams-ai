const fs = require('fs');
const os = require('os');
const path = require('path');
const { createController } = require('../src/index.js');
const kanban = require('../src/internal/kanban.js');
const kanbanStore = require('../src/internal/kanbanStore.js');

describe('configurable review flow', () => {
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
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const taskFile = (id) => path.join(dir, 'tasks', 'fixture', id + '.json');
  const kanbanFile = () => path.join(dir, 'teams', 'fixture', 'kanban-state.json');
  const events = (id, type) => board.getTask(id).historyEvents.filter((e) => e.type === type);

  it('keeps opt-in disabled and preserves the existing agent approval workflow', () => {
    const task = board.createTask({ subject: 'Legacy approval', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    expect(board.getKanbanState().reviewFlow).toBe('agent_approval');
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    board.approveReview(task.id, { from: 'alice' });
    expect(board.getTask(task.id).reviewState).toBe('approved');
    expect(events(task.id, 'review_approved')).toHaveLength(1);
  });

  it('closes only the requested cycle to reviewed Done and allows human acceptance', () => {
    const task = board.createTask({ subject: 'Require human acceptance', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
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

  it('recovers both dependency and lead notices after an interrupted review completion', () => {
    const task = board.createTask({ subject: 'Interrupted review completion', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const dependent = board.createTask({
      subject: 'Blocked during review', owner: 'bob', blockedBy: [task.id],
    });
    const cycle = events(task.id, 'review_requested')[0].id;
    const inboxFile = path.join(dir, 'teams', 'fixture', 'inboxes', 'alice.json');
    const leadInboxBefore = JSON.parse(fs.readFileSync(inboxFile, 'utf8')).length;
    const dependentCommentsBefore = (board.getTask(dependent.id).comments ?? []).length;
    const fail = vi.spyOn(kanban, 'clearKanban').mockImplementationOnce(() => {
      throw new Error('synthetic kanban overlay write failure');
    });
    expect(() => board.completeReview(task.id, {
      from: 'alice', expectedReviewRequestId: cycle,
    })).toThrow(/synthetic kanban/);
    fail.mockRestore();
    expect(board.getTask(task.id).reviewState).toBe('reviewed');
    expect(board.getKanbanState().tasks[task.id].column).toBe('review');
    expect(JSON.parse(fs.readFileSync(inboxFile, 'utf8'))).toHaveLength(leadInboxBefore);

    expect(board.completeReview(task.id, {
      from: 'alice', expectedReviewRequestId: cycle,
    })).toMatchObject({ alreadyCompleted: true, column: 'done' });
    expect(board.getKanbanState().tasks[task.id]).toBeUndefined();
    expect((board.getTask(dependent.id).comments ?? []).length).toBeGreaterThan(dependentCommentsBefore);
    const leadInboxAfter = JSON.parse(fs.readFileSync(inboxFile, 'utf8')).length;
    expect(leadInboxAfter).toBeGreaterThan(leadInboxBefore);
    expect(events(task.id, 'review_completed')).toHaveLength(1);

    board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
    expect(JSON.parse(fs.readFileSync(inboxFile, 'utf8'))).toHaveLength(leadInboxAfter);
    expect(events(task.id, 'review_completed')).toHaveLength(1);
  });

  it('replays notices after a review overlay was persisted before an error', () => {
    const task = board.createTask({ subject: 'Post-write review failure', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const dependent = board.createTask({
      subject: 'Waiting on AI review', owner: 'bob', blockedBy: [task.id],
    });
    const cycle = events(task.id, 'review_requested').at(-1).id;
    const inboxFile = path.join(dir, 'teams', 'fixture', 'inboxes', 'alice.json');
    const leadBefore = JSON.parse(fs.readFileSync(inboxFile, 'utf8')).length;
    const commentsBefore = (board.getTask(dependent.id).comments ?? []).length;
    const realClear = kanban.clearKanban;
    const fail = vi.spyOn(kanban, 'clearKanban').mockImplementationOnce((...args) => {
      realClear(...args);
      throw new Error('synthetic error after review overlay write');
    });
    expect(() => board.completeReview(task.id, {
      from: 'alice', expectedReviewRequestId: cycle,
    })).toThrow(/after review overlay write/);
    fail.mockRestore();

    expect(board.getKanbanState().tasks[task.id]).toBeUndefined();
    expect(board.getTask(task.id).reviewState).toBe('reviewed');
    expect((board.getTask(dependent.id).comments ?? [])).toHaveLength(commentsBefore);
    expect(JSON.parse(fs.readFileSync(inboxFile, 'utf8'))).toHaveLength(leadBefore);

    expect(board.completeReview(task.id, {
      from: 'alice', expectedReviewRequestId: cycle,
    })).toMatchObject({ alreadyCompleted: true, column: 'done' });
    const commentsAfter = (board.getTask(dependent.id).comments ?? []).length;
    const leadAfter = JSON.parse(fs.readFileSync(inboxFile, 'utf8')).length;
    expect(commentsAfter).toBe(commentsBefore + 1);
    expect(leadAfter).toBe(leadBefore + 1);
    board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
    expect((board.getTask(dependent.id).comments ?? [])).toHaveLength(commentsAfter);
    expect(JSON.parse(fs.readFileSync(inboxFile, 'utf8'))).toHaveLength(leadAfter);
    expect(events(task.id, 'review_completed')).toHaveLength(1);
  });

  it('repairs an Approved placement without treating it as recorded human consent', () => {
    const task = board.createTask({ subject: 'Recover human history', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    const state = JSON.parse(fs.readFileSync(kanbanFile(), 'utf8'));
    state.tasks[task.id] = { column: 'approved', movedAt: new Date().toISOString() };
    fs.writeFileSync(kanbanFile(), JSON.stringify(state));
    const rawTask = JSON.parse(fs.readFileSync(taskFile(task.id), 'utf8'));
    rawTask.reviewState = 'approved';
    fs.writeFileSync(taskFile(task.id), JSON.stringify(rawTask));
    expect(events(task.id, 'human_approved')).toHaveLength(0);
    expect(board.approveAsHuman(task.id).reviewState).toBe('approved');
    expect(events(task.id, 'human_approved')).toHaveLength(1);
    board.approveAsHuman(task.id);
    expect(events(task.id, 'human_approved')).toHaveLength(1);
  });

  it('repairs interrupted human approval after disabling the policy', () => {
    const task = board.createTask({ subject: 'Interrupted human acceptance', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    const fail = vi.spyOn(kanbanStore, 'setKanbanColumn').mockImplementationOnce(() => {
      throw new Error('synthetic human overlay failure');
    });
    expect(() => board.approveAsHuman(task.id)).toThrow(/synthetic human overlay/);
    fail.mockRestore();
    expect(events(task.id, 'human_approved')).toHaveLength(1);
    expect(board.getKanbanState().tasks[task.id]).toBeUndefined();
    board.setReviewFlowSettings({ reviewFlow: 'agent_approval' });
    expect(board.approveAsHuman(task.id)).toMatchObject({ reviewState: 'approved' });
    expect(board.getKanbanState().tasks[task.id].column).toBe('approved');
    expect(events(task.id, 'human_approved')).toHaveLength(1);
  });

  it('replays dependency notice after the human approval overlay already persisted', () => {
    const task = board.createTask({ subject: 'Human approval post-write failure', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const dependent = board.createTask({
      subject: 'Waiting on human approval', owner: 'bob', blockedBy: [task.id],
    });
    const commentsBefore = (board.getTask(dependent.id).comments ?? []).length;
    const realSet = kanbanStore.setKanbanColumn;
    const fail = vi.spyOn(kanbanStore, 'setKanbanColumn').mockImplementationOnce((...args) => {
      realSet(...args);
      throw new Error('synthetic error after human overlay write');
    });
    expect(() => board.approveAsHuman(task.id)).toThrow(/after human overlay write/);
    fail.mockRestore();

    expect(board.getKanbanState().tasks[task.id].column).toBe('approved');
    expect(events(task.id, 'human_approved')).toHaveLength(1);
    expect((board.getTask(dependent.id).comments ?? [])).toHaveLength(commentsBefore);

    expect(board.approveAsHuman(task.id).reviewState).toBe('approved');
    const commentsAfter = (board.getTask(dependent.id).comments ?? []).length;
    expect(commentsAfter).toBe(commentsBefore + 1);
    board.approveAsHuman(task.id);
    expect((board.getTask(dependent.id).comments ?? [])).toHaveLength(commentsAfter);
    expect(events(task.id, 'human_approved')).toHaveLength(1);
  });

  it('resumes an interrupted human rejection without duplicate events or owner messages', () => {
    const task = board.createTask({ subject: 'Interrupted human rejection', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const cycle = events(task.id, 'review_requested')[0].id;
    board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });

    const fail = vi.spyOn(kanban, 'clearKanban').mockImplementationOnce(() => {
      throw new Error('synthetic human rejection overlay failure');
    });
    expect(() => board.requestChangesAsHuman(task.id, {
      comment: 'Original user feedback',
    })).toThrow(/synthetic human rejection/);
    fail.mockRestore();
    expect(board.getTask(task.id)).toMatchObject({
      status: 'completed', reviewState: 'needsFix',
    });
    expect(events(task.id, 'review_changes_requested')).toHaveLength(1);

    const result = board.requestChangesAsHuman(task.id, { comment: 'Changed on retry' });
    expect(result).toMatchObject({ status: 'pending', reviewState: 'needsFix' });
    expect(events(task.id, 'review_changes_requested')).toHaveLength(1);
    expect(board.getTask(task.id).comments.some((comment) =>
      comment.text === 'Original user feedback'
    )).toBe(true);
    const inboxFile = path.join(dir, 'teams', 'fixture', 'inboxes', 'bob.json');
    const ownerInbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    const commentCount = board.getTask(task.id).comments.length;
    const inboxCount = ownerInbox.length;
    board.requestChangesAsHuman(task.id, { comment: 'Original user feedback' });
    expect(board.getTask(task.id).comments).toHaveLength(commentCount);
    expect(JSON.parse(fs.readFileSync(inboxFile, 'utf8'))).toHaveLength(inboxCount);
    expect(events(task.id, 'review_changes_requested')).toHaveLength(1);
  });

  it('recovers dependency wake-ups after interrupted human acceptance from Review', () => {
    const blocker = board.createTask({ subject: 'Human review blocker', owner: 'bob' });
    board.completeTask(blocker.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(blocker.id, { from: 'alice', reviewer: 'alice' });
    const dependent = board.createTask({
      subject: 'Dependent of user approval', owner: 'bob', blockedBy: [blocker.id],
    });
    const beforeComments = (board.getTask(dependent.id).comments ?? []).length;
    const fail = vi.spyOn(kanbanStore, 'setKanbanColumn').mockImplementationOnce(() => {
      throw new Error('synthetic approval overlay write failed');
    });
    expect(() => board.approveAsHuman(blocker.id)).toThrow(/synthetic approval overlay/);
    fail.mockRestore();
    expect(events(blocker.id, 'human_approved')).toHaveLength(1);
    expect((board.getTask(dependent.id).comments ?? [])).toHaveLength(beforeComments);
    expect(board.approveAsHuman(blocker.id).reviewState).toBe('approved');
    const afterComments = (board.getTask(dependent.id).comments ?? []).length;
    expect(afterComments).toBeGreaterThan(beforeComments);
    expect(events(blocker.id, 'human_approved')).toHaveLength(1);
    board.approveAsHuman(blocker.id);
    expect((board.getTask(dependent.id).comments ?? [])).toHaveLength(afterComments);
  });

  it('rejects stale, absent, wrong-reviewer and superseded cycle IDs without mutation', () => {
    const task = board.createTask({ subject: 'Stale cycle', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
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

  it('retains manual acceptance of reviewed Done after the policy is switched off', () => {
    const task = board.createTask({ subject: 'Reviewed before toggle', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const cycle = events(task.id, 'review_requested')[0].id;
    board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
    board.setReviewFlowSettings({ reviewFlow: 'agent_approval' });
    expect(() => board.approveReview(task.id, { from: 'alice' })).toThrow(/must be in review/);
    expect(board.approveAsHuman(task.id)).toMatchObject({ reviewState: 'approved' });
    expect(events(task.id, 'human_approved')).toHaveLength(1);
    expect(board.completeReview(task.id, {
      from: 'alice', expectedReviewRequestId: cycle,
    })).toMatchObject({ alreadyCompleted: true, reviewState: 'approved', column: 'approved' });
  });

  it('lets only the trusted human path request changes from reviewed Done', () => {
    const task = board.createTask({ subject: 'Human rejects AI review', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const cycle = events(task.id, 'review_requested')[0].id;
    board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
    expect(() => board.requestChanges(task.id, {
      from: 'alice', comment: 'Fix this', expectedReviewRequestId: cycle,
    })).toThrow(/must be in review/);
    const changed = board.requestChangesAsHuman(task.id, { comment: 'Needs a fix' });
    expect(changed).toMatchObject({ status: 'pending', reviewState: 'needsFix' });
    expect(events(task.id, 'review_changes_requested').at(-1)).toMatchObject({
      from: 'reviewed', to: 'needsFix', actor: 'user',
    });
    const commentsBeforeRetry = board.getTask(task.id).comments.length;
    expect(board.requestChangesAsHuman(task.id, { comment: 'Again' }))
      .toMatchObject({ status: 'pending', reviewState: 'needsFix' });
    expect(events(task.id, 'review_changes_requested')).toHaveLength(1);
    expect(board.getTask(task.id).comments).toHaveLength(commentsBeforeRetry);
  });

  it('rejects stale or missing reviewer rejection tokens without changing the board', () => {
    const task = board.createTask({ subject: 'Reject stale review decision', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const cycle = events(task.id, 'review_requested')[0].id;
    const beforeTask = fs.readFileSync(taskFile(task.id), 'utf8');
    const beforeBoard = fs.readFileSync(kanbanFile(), 'utf8');
    expect(() => board.requestChanges(task.id, { from: 'alice', comment: 'No token' }))
      .toThrow(/Stale review request/);
    expect(() => board.requestChanges(task.id, {
      from: 'alice', comment: 'Stale token', expectedReviewRequestId: 'unknown',
    })).toThrow(/Stale review request/);
    expect(fs.readFileSync(taskFile(task.id), 'utf8')).toBe(beforeTask);
    expect(fs.readFileSync(kanbanFile(), 'utf8')).toBe(beforeBoard);
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    expect(() => board.requestChanges(task.id, {
      from: 'alice', expectedReviewRequestId: cycle,
    })).toThrow(/Stale review request/);
    expect(board.getTask(task.id).status).toBe('completed');
    const currentCycle = events(task.id, 'review_requested').at(-1).id;
    expect(board.requestChanges(task.id, {
      from: 'alice', expectedReviewRequestId: currentCycle, comment: 'Fix this',
    })).toMatchObject({ status: 'pending', reviewState: 'needsFix' });
  });


  it('moves the board message epoch after AI review and human acceptance without duplicate delivery', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-16T10:00:00.000Z'));
      const task = board.createTask({ subject: 'Review done message', owner: 'bob' });
      board.completeTask(task.id, 'bob');
      const first = controller.messages.sendMessage({
        to: 'user', from: 'alice', text: 'Implementation has finished.',
      });
      expect(first.deduplicated).toBeUndefined();

      vi.advanceTimersByTime(1000);
      board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
      board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
      const cycle = events(task.id, 'review_requested').at(-1).id;
      vi.advanceTimersByTime(1000);
      board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
      const afterReview = controller.messages.sendMessage({
        to: 'user', from: 'alice', text: 'The AI review has passed, awaiting human acceptance.',
      });
      expect(afterReview.deduplicated).toBeUndefined();
      vi.advanceTimersByTime(1000);
      const repeatReview = controller.messages.sendMessage({
        to: 'user', from: 'alice', text: 'Repeating the same completed review status.',
      });
      expect(repeatReview.deduplicated).toBe(true);

      vi.advanceTimersByTime(1000);
      board.approveAsHuman(task.id);
      const afterHumanApproval = controller.messages.sendMessage({
        to: 'user', from: 'alice', text: 'The user accepted the reviewed work.',
      });
      expect(afterHumanApproval.deduplicated).toBeUndefined();
      const repeat = controller.messages.sendMessage({
        to: 'user', from: 'alice', text: 'Repeating acceptance without a board change.',
      });
      expect(repeat.deduplicated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not notify dependents again when a reviewed Done task is accepted by a human', () => {
    const blocker = board.createTask({ subject: 'Reviewed blocker', owner: 'bob' });
    const dependent = board.createTask({
      subject: 'Depends on reviewed blocker', owner: 'bob', blockedBy: [blocker.id],
    });
    board.completeTask(blocker.id, 'bob');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.requestReview(blocker.id, { from: 'alice', reviewer: 'alice' });
    const reviewId = events(blocker.id, 'review_requested').at(-1).id;
    board.completeReview(blocker.id, { from: 'alice', expectedReviewRequestId: reviewId });
    const beforeComments = (board.getTask(dependent.id).comments ?? []).length;
    const inboxPath = path.join(dir, 'teams', 'fixture', 'inboxes', 'bob.json');
    const beforeInbox = fs.existsSync(inboxPath)
      ? JSON.parse(fs.readFileSync(inboxPath, 'utf8')).length
      : 0;
    expect(beforeComments).toBeGreaterThan(0);
    board.approveAsHuman(blocker.id);
    expect((board.getTask(dependent.id).comments ?? [])).toHaveLength(beforeComments);
    expect(JSON.parse(fs.readFileSync(inboxPath, 'utf8'))).toHaveLength(beforeInbox);
  });

  it('preserves settings through kanban writes and fails closed for corrupt stored policy', () => {
    board.addReviewer('alice');
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.removeReviewer('alice');
    expect(board.getKanbanState().reviewFlow).toBe('human_approval');
    const disk = JSON.parse(fs.readFileSync(kanbanFile(), 'utf8'));
    expect(disk.reviewFlow).toBe('human_approval');
    disk.reviewFlow = 'everyone';
    fs.writeFileSync(kanbanFile(), JSON.stringify(disk));
    expect(() => board.getKanbanState()).toThrow(/review flow is corrupt/);
    expect(() => board.setReviewFlowSettings({ reviewFlow: 'agent_approval' })).toThrow(/review flow is corrupt/);
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

  it('rejects unknown flows, empty settings and agent-forged values without persisting', () => {
    expect(() => board.setReviewFlowSettings({ reviewFlow: 'everyone' })).toThrow(/reviewFlow must be one of/);
    expect(() => board.setReviewFlowSettings({})).toThrow(/empty/);
    expect(() => board.setReviewFlowSettings({ reviewFlowPrompt: 'x'.repeat(1001) })).toThrow(/at most 1000/);
    expect(() => board.setReviewFlowSettings({ reviewFlowPrompt: 5 })).toThrow(/must be a string/);
    expect(board.getKanbanState()).toMatchObject({ reviewFlow: 'agent_approval' });
    expect(board.getKanbanState().reviewFlowPrompt).toBeUndefined();
  });

  it('keeps the flow when only the prompt changes and clears the prompt with empty text', () => {
    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    board.setReviewFlowSettings({ reviewFlowPrompt: '  Check the migration plan first.  ' });
    expect(board.getKanbanState()).toMatchObject({
      reviewFlow: 'human_approval', reviewFlowPrompt: 'Check the migration plan first.',
    });
    board.setReviewFlowSettings({ reviewFlow: 'agent_approval' });
    expect(board.getKanbanState()).toMatchObject({
      reviewFlow: 'agent_approval', reviewFlowPrompt: 'Check the migration plan first.',
    });
    board.setReviewFlowSettings({ reviewFlowPrompt: '   ' });
    expect(board.getKanbanState().reviewFlowPrompt).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(kanbanFile(), 'utf8')).reviewFlowPrompt).toBeUndefined();
  });

  it('delivers the owner prompt to the reviewer without changing who may approve', () => {
    board.setReviewFlowSettings({ reviewFlow: 'human_approval', reviewFlowPrompt: 'Run the e2e suite before deciding.' });
    const task = board.createTask({ subject: 'Prompted review', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.addReviewer('alice');
    board.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
    const inbox = JSON.parse(fs.readFileSync(
      path.join(dir, 'teams', 'fixture', 'inboxes', 'alice.json'), 'utf8'
    ));
    const text = inbox.map((msg) => msg.text).join('\n');
    expect(text).toContain('Run the e2e suite before deciding.');
    expect(text).toContain('do not change which tools you may use');
    expect(() => board.approveReview(task.id, { from: 'alice' })).toThrow(/Human approval required/);
  });
});
