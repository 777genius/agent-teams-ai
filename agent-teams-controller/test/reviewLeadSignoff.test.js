const fs = require('fs');
const os = require('os');
const path = require('path');
const { createController } = require('../src/index.js');
const messagesModule = require('../src/internal/messages.js');
const { parseReviewFlowSettings } = require('../src/internal/reviewFlow.js');

describe('lead_then_human review flow', () => {
  let dir;
  let board;

  const writeConfig = (members) =>
    fs.writeFileSync(path.join(dir, 'teams', 'fixture', 'config.json'), JSON.stringify({
      name: 'fixture', leadSessionId: 'lead-session-1', members,
    }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-signoff-'));
    fs.mkdirSync(path.join(dir, 'teams', 'fixture'), { recursive: true });
    writeConfig([
      { name: 'alice', role: 'team-lead' },
      { name: 'bob', role: 'developer' },
      { name: 'carol', role: 'reviewer' },
    ]);
    board = createController({ teamName: 'fixture', claudeDir: dir }).taskBoard;
    board.setReviewFlowSettings({ reviewFlow: 'lead_then_human' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const events = (id, type) => board.getTask(id).historyEvents.filter((e) => e.type === type);
  const inbox = (member) => {
    const file = path.join(dir, 'teams', 'fixture', 'inboxes', `${member}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  };
  const signoffMessages = () => inbox('alice').filter((m) => m.summary?.startsWith('Lead sign-off requested'));

  /** A completed task whose first review (reviewer `carol`) is requested and started. */
  function reviewedByCarol(options = {}) {
    const task = board.createTask({ subject: 'Ship it', owner: options.owner ?? 'bob' });
    board.completeTask(task.id, options.owner ?? 'bob');
    board.requestReview(task.id, { from: 'alice', reviewer: options.reviewer ?? 'carol' });
    const cycle = events(task.id, 'review_requested').at(-1).id;
    board.startReview(task.id, { from: options.reviewer ?? 'carol' });
    return { task, cycle };
  }

  it('accepts the flow as a complete settings unit', () => {
    expect(parseReviewFlowSettings({ reviewFlow: 'lead_then_human', reviewFlowPrompt: ' x ' }))
      .toEqual({ reviewFlow: 'lead_then_human', reviewFlowPrompt: 'x' });
    expect(() => board.approveReview(reviewedByCarol().task.id, { from: 'carol' }))
      .toThrow(/Human approval required/);
  });

  it('hands the completed review to the Lead instead of Done, once', () => {
    const { task, cycle } = reviewedByCarol();
    const dependent = board.createTask({ subject: 'Waits', owner: 'bob', blockedBy: [task.id] });
    const commentsBefore = (board.getTask(dependent.id).comments ?? []).length;

    const result = board.completeReview(task.id, {
      from: 'carol', expectedReviewRequestId: cycle, note: 'Looks good',
    });
    const signoff = events(task.id, 'review_requested').at(-1);
    expect(result).toMatchObject({
      ok: true, taskId: task.id, column: 'review', reviewState: 'review',
      stage: 'lead_signoff', handedOffTo: 'alice', reviewRequestId: cycle,
      leadSignoffRequestId: signoff.id, alreadyCompleted: false,
    });
    expect(signoff).toMatchObject({
      type: 'review_requested', from: 'review', to: 'review', reviewer: 'alice',
      stage: 'lead_signoff', afterReviewRequestId: cycle, note: 'Looks good', actor: 'carol',
    });
    expect(signoff.id).not.toBe(cycle);
    expect(board.getTask(task.id)).toMatchObject({ status: 'completed', reviewState: 'review' });
    expect(board.getKanbanState().tasks[task.id].column).toBe('review');
    expect(events(task.id, 'review_completed')).toHaveLength(0);
    expect((board.getTask(dependent.id).comments ?? [])).toHaveLength(commentsBefore);
    const messages = signoffMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain(signoff.id);
    expect(messages[0].text).toContain('Lead sign-off requested');
    expect(messages[0].text).toContain('Looks good');
    expect(inbox('alice').some((m) => m.summary?.startsWith('AI review completed'))).toBe(false);

    const retry = board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    expect(retry).toMatchObject({
      alreadyCompleted: true, reviewRequestId: cycle, leadSignoffRequestId: signoff.id, column: 'review',
    });
    expect(events(task.id, 'review_requested')).toHaveLength(2);
    expect(signoffMessages()).toHaveLength(1);
  });

  it('keeps the first reviewer out of the sign-off cycle', () => {
    const { task, cycle } = reviewedByCarol();
    board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    const signoff = events(task.id, 'review_requested').at(-1).id;

    expect(() => board.requestChanges(task.id, {
      from: 'carol', comment: 'late', expectedReviewRequestId: cycle,
    })).toThrow(/Stale review request/);
    expect(() => board.requestChanges(task.id, {
      from: 'carol', comment: 'late', expectedReviewRequestId: signoff,
    })).toThrow(/assigned to reviewer alice/);
    expect(() => board.completeReview(task.id, {
      from: 'bob', expectedReviewRequestId: signoff,
    })).toThrow(/assigned to reviewer alice/);
    expect(() => board.completeReview(task.id, {
      from: 'carol', expectedReviewRequestId: signoff,
    })).toThrow(/assigned to reviewer alice/);
    expect(board.getTask(task.id).reviewState).toBe('review');
  });

  it('lets the Lead finish the sign-off to reviewed Done awaiting the human', () => {
    const { task, cycle } = reviewedByCarol();
    const dependent = board.createTask({ subject: 'Waits', owner: 'bob', blockedBy: [task.id] });
    board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    const signoff = events(task.id, 'review_requested').at(-1).id;
    expect(board.startReview(task.id, { from: 'alice' }).reviewRequestId).toBe(signoff);

    expect(board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: signoff }))
      .toMatchObject({ column: 'done', reviewState: 'reviewed', alreadyCompleted: false });
    expect(events(task.id, 'review_completed')).toHaveLength(1);
    expect(board.getKanbanState().tasks[task.id]).toBeUndefined();
    expect((board.getTask(dependent.id).comments ?? []).length).toBe(1);
    expect(() => board.approveReview(task.id, { from: 'alice' })).toThrow(/Human approval required/);
    expect(board.approveAsHuman(task.id).reviewState).toBe('approved');
  });

  it('restarts a full review cycle after the Lead requests changes', () => {
    const { task, cycle } = reviewedByCarol();
    board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    const signoff = events(task.id, 'review_requested').at(-1).id;

    board.requestChanges(task.id, {
      from: 'alice', comment: 'Fix the edge case', expectedReviewRequestId: signoff,
    });
    expect(board.getTask(task.id).reviewState).toBe('needsFix');

    board.startTask(task.id, 'bob');
    board.completeTask(task.id, 'bob');
    board.requestReview(task.id, { from: 'alice', reviewer: 'carol' });
    const next = events(task.id, 'review_requested').at(-1);
    expect(next.stage).toBeUndefined();
    expect(next.reviewer).toBe('carol');
    board.startReview(task.id, { from: 'carol' });
    expect(board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: next.id }))
      .toMatchObject({ stage: 'lead_signoff', column: 'review' });
  });

  it('lets the human accept or reject while the task awaits sign-off', () => {
    const { task, cycle } = reviewedByCarol();
    const dependent = board.createTask({ subject: 'Waits', owner: 'bob', blockedBy: [task.id] });
    board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    expect(board.approveAsHuman(task.id).reviewState).toBe('approved');
    expect(board.getKanbanState().tasks[task.id].column).toBe('approved');
    expect((board.getTask(dependent.id).comments ?? []).length).toBe(1);

    const second = reviewedByCarol();
    board.completeReview(second.task.id, { from: 'carol', expectedReviewRequestId: second.cycle });
    board.requestChangesAsHuman(second.task.id, { comment: 'No' });
    expect(board.getTask(second.task.id).reviewState).toBe('needsFix');
  });

  it.each([
    ['the Lead reviews first', { reviewer: 'alice' }, 'alice', 'actor_is_lead'],
    ['the Lead submitted the work', { owner: 'alice' }, 'carol', 'work_by_lead'],
  ])('closes the cycle directly when %s', (_label, options, actor, reason) => {
    const { task, cycle } = reviewedByCarol(options);
    expect(board.completeReview(task.id, { from: actor, expectedReviewRequestId: cycle }))
      .toMatchObject({ column: 'done', reviewState: 'reviewed', leadSignoffSkipped: reason });
    expect(events(task.id, 'review_requested')).toHaveLength(1);
    expect(signoffMessages()).toHaveLength(0);
  });

  it('does not notify the Lead about its own decisions', () => {
    const { task, cycle } = reviewedByCarol({ reviewer: 'alice' });
    board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle });
    expect(inbox('alice').some((m) => m.summary?.startsWith('AI review completed'))).toBe(false);

    const second = reviewedByCarol();
    board.completeReview(second.task.id, { from: 'carol', expectedReviewRequestId: second.cycle });
    const signoff = events(second.task.id, 'review_requested').at(-1).id;
    board.completeReview(second.task.id, { from: 'alice', expectedReviewRequestId: signoff });
    expect(inbox('alice').some((m) => m.summary?.startsWith('AI review completed'))).toBe(false);
  });

  it('closes the cycle directly when the team has no resolvable Lead', () => {
    const { task, cycle } = reviewedByCarol();
    fs.writeFileSync(path.join(dir, 'teams', 'fixture', 'members.meta.json'), JSON.stringify({
      members: [{ name: 'alice', role: 'team-lead', removedAt: Date.now() }],
    }));
    expect(board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle }))
      .toMatchObject({ column: 'done', reviewState: 'reviewed', leadSignoffSkipped: 'no_lead' });
  });

  it('always lists the open sign-offs in the Lead briefing with the current request id', async () => {
    const { task, cycle } = reviewedByCarol();
    expect(await board.leadBriefing()).toContain('leadSignoff=0');
    board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    const signoff = events(task.id, 'review_requested').at(-1).id;

    const briefing = await board.leadBriefing();
    const [, section, rest] = briefing.match(/Awaiting your sign-off:\n([\s\S]*?)\n\n([\s\S]*)/);
    expect(section).toContain(`#${board.getTask(task.id).displayId || task.id}`);
    expect(section).toContain('Ship it');
    expect(section).toContain(`expectedReviewRequestId="${signoff}"`);
    expect(section).toContain('review_start');
    expect(briefing).toContain('leadSignoff=1');
    expect(rest).not.toContain('Lead-owned follow-up');

    board.startReview(task.id, { from: 'alice' });
    expect(await board.leadBriefing()).toContain('Awaiting your sign-off:');
    board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: signoff });
    const done = await board.leadBriefing();
    expect(done).not.toContain('Awaiting your sign-off:');
    expect(done).toContain('leadSignoff=0');
  });
  describe('review decisions bound to a named actor', () => {
    it('refuses to infer the actor, so nobody completes the sign-off as the Lead', () => {
      const { task, cycle } = reviewedByCarol();
      board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
      const signoff = events(task.id, 'review_requested').at(-1).id;

      expect(() => board.completeReview(task.id, { expectedReviewRequestId: signoff }))
        .toThrow(/requires an explicit "from"/);
      expect(() => board.requestChanges(task.id, { comment: 'x', expectedReviewRequestId: signoff }))
        .toThrow(/requires an explicit "from"/);
      expect(() => board.completeReview(task.id, { expectedReviewRequestId: cycle }))
        .toThrow(/requires an explicit "from"/);
      expect(board.getTask(task.id).reviewState).toBe('review');
      expect(events(task.id, 'review_completed')).toHaveLength(0);
    });

    it('does not let an owner skip both stages by leaving the actor out', () => {
      const task = board.createTask({ subject: 'Self service', owner: 'bob' });
      board.completeTask(task.id, 'bob');
      board.requestReview(task.id, { from: 'bob' });
      const cycle = events(task.id, 'review_requested').at(-1).id;
      expect(() => board.completeReview(task.id, { expectedReviewRequestId: cycle }))
        .toThrow(/requires an explicit "from"/);
      expect(board.completeReview(task.id, { from: 'bob', expectedReviewRequestId: cycle }))
        .toMatchObject({ stage: 'lead_signoff', column: 'review' });
    });

    it('still lets agent_approval and human_approval infer the actor as before', () => {
      board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
      const { task, cycle } = reviewedByCarol();
      expect(board.completeReview(task.id, { expectedReviewRequestId: cycle }))
        .toMatchObject({ column: 'done', reviewState: 'reviewed' });
    });
  });

  describe('idempotent hand-off retries', () => {
    it('answers only the reviewer who handed off, and only while the sign-off is the latest request', () => {
      const { task, cycle } = reviewedByCarol();
      board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
      const signoff = events(task.id, 'review_requested').at(-1).id;

      expect(() => board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: cycle }))
        .toThrow(/Stale review request/);
      expect(() => board.completeReview(task.id, { from: 'bob', expectedReviewRequestId: cycle }))
        .toThrow(/Stale review request/);
      expect(() => board.completeReview(task.id, { expectedReviewRequestId: cycle }))
        .toThrow(/requires an explicit "from"/);

      board.requestChanges(task.id, { from: 'alice', comment: 'again', expectedReviewRequestId: signoff });
      expect(() => board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle }))
        .toThrow(/Stale review request|must be/);

      board.startTask(task.id, 'bob');
      board.completeTask(task.id, 'bob');
      board.requestReview(task.id, { from: 'alice', reviewer: 'carol' });
      expect(() => board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle }))
        .toThrow(/Stale review request/);
    });

    it('keeps answering the retry after the Lead decided, with the real state', () => {
      const { task, cycle } = reviewedByCarol();
      board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
      const signoff = events(task.id, 'review_requested').at(-1).id;
      board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: signoff });
      expect(board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle }))
        .toMatchObject({ alreadyCompleted: true, reviewState: 'reviewed', column: 'done' });
      expect(signoffMessages()).toHaveLength(1);
    });

    it('re-sends a failed sign-off request on retry without duplicating the inbox row', () => {
      const { task, cycle } = reviewedByCarol();
      const send = vi.spyOn(messagesModule, 'sendMessage').mockImplementationOnce(() => {
        throw new Error('inbox unavailable');
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
      const signoff = events(task.id, 'review_requested').at(-1).id;
      expect(send).toHaveBeenCalledTimes(1);
      expect(signoffMessages()).toHaveLength(0);

      send.mockRestore();
      board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
      board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
      expect(events(task.id, 'review_requested')).toHaveLength(2);
      const rows = signoffMessages();
      expect(rows).toHaveLength(1);
      expect(rows[0].messageId).toBe(signoff);
    });
  });

  describe('who counts as having done the work', () => {
    const reassignedToLead = (when) => {
      const task = board.createTask({ subject: 'Reassigned', owner: 'bob' });
      board.completeTask(task.id, 'bob');
      if (when === 'before') board.setTaskOwner(task.id, 'alice', 'bob');
      board.requestReview(task.id, { from: 'bob', reviewer: 'carol' });
      const cycle = events(task.id, 'review_requested').at(-1).id;
      board.startReview(task.id, { from: 'carol' });
      if (when === 'during') board.setTaskOwner(task.id, 'alice', 'bob');
      return { task, cycle };
    };

    it.each(['before', 'during'])('does not skip the sign-off when the owner is reassigned to the Lead %s the review', (when) => {
      const { task, cycle } = reassignedToLead(when);
      expect(board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle }))
        .toMatchObject({ stage: 'lead_signoff', column: 'review' });
    });

    it('does not skip it for a second cycle after the owner became the Lead during the first', () => {
      const task = board.createTask({ subject: 'Mid-review reassigned', owner: 'bob' });
      board.completeTask(task.id, 'bob');
      board.requestReview(task.id, { from: 'alice', reviewer: 'carol' });
      const first = board.startReview(task.id, { from: 'carol' }).reviewRequestId;
      board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: first });
      board.setTaskOwner(task.id, 'alice', 'bob');
      board.requestReview(task.id, { from: 'bob', reviewer: 'carol' });
      const second = board.startReview(task.id, { from: 'carol' }).reviewRequestId;
      expect(board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: second }))
        .toMatchObject({ stage: 'lead_signoff', column: 'review' });
    });

    it('never skips when the submitter is unknown, and records the reason when it does skip', () => {
      const anonymous = board.createTask({ subject: 'No actor', owner: 'alice' });
      board.completeTask(anonymous.id);
      board.requestReview(anonymous.id, { from: 'alice', reviewer: 'carol' });
      const cycle = events(anonymous.id, 'review_requested').at(-1).id;
      board.startReview(anonymous.id, { from: 'carol' });
      expect(board.completeReview(anonymous.id, { from: 'carol', expectedReviewRequestId: cycle }))
        .toMatchObject({ stage: 'lead_signoff' });

      const own = reviewedByCarol({ owner: 'alice' });
      board.completeReview(own.task.id, { from: 'carol', expectedReviewRequestId: own.cycle });
      expect(events(own.task.id, 'review_completed')[0].leadSignoffSkipped).toBe('work_by_lead');
    });
  });

  it('files an open sign-off under "Awaiting your sign-off" even when the owner is the Lead', async () => {
    const task = board.createTask({ subject: 'Mid-review reassigned', owner: 'bob' });
    board.completeTask(task.id, 'bob');
    board.requestReview(task.id, { from: 'alice', reviewer: 'carol' });
    const cycle = board.startReview(task.id, { from: 'carol' }).reviewRequestId;
    board.setTaskOwner(task.id, 'alice', 'bob');
    board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    const signoff = events(task.id, 'review_requested').at(-1).id;

    const briefing = await board.leadBriefing();
    expect(briefing).toContain('Awaiting your sign-off:');
    expect(briefing).toContain(`expectedReviewRequestId="${signoff}"`);
    expect(briefing).toContain('explicit "from"');
    expect(briefing).not.toContain('self_review_invalid');
    expect(briefing).not.toContain('Needs reviewer assignment');
  });

  it('keeps the Lead-only sign-off hint out of the members\' briefings', async () => {
    const { task, cycle } = reviewedByCarol();
    board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    for (const member of ['bob', 'carol']) {
      expect(String(await board.taskBriefing(member))).not.toContain('Sign-off: call review_start');
    }
    expect(await board.leadBriefing()).toContain('Sign-off: call review_start');
  });

  it('keeps requiring an explicit actor for an open sign-off after the flow was switched', () => {
    const { task, cycle } = reviewedByCarol();
    board.completeReview(task.id, { from: 'carol', expectedReviewRequestId: cycle });
    const signoff = events(task.id, 'review_requested').at(-1).id;

    board.setReviewFlowSettings({ reviewFlow: 'human_approval' });
    expect(() => board.completeReview(task.id, { expectedReviewRequestId: signoff }))
      .toThrow(/requires an explicit "from"/);
    expect(() => board.requestChanges(task.id, { comment: 'x', expectedReviewRequestId: signoff }))
      .toThrow(/requires an explicit "from"/);
    board.setReviewFlowSettings({ reviewFlow: 'agent_approval' });
    expect(() => board.approveReview(task.id, {})).toThrow(/requires an explicit "from"/);
    expect(board.getTask(task.id).reviewState).toBe('review');
    expect(board.completeReview(task.id, { from: 'alice', expectedReviewRequestId: signoff }))
      .toMatchObject({ reviewState: 'reviewed' });
  });
});
