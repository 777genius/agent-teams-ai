const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

// The board-completion notice (tasks.js) and the post-completion message guard
// (messageStore.js) both ask "is any task on this board still open?". These
// cases put the same board in front of both and assert they answer the same
// way, on the two fixtures where the two used to disagree.
describe('board completion is one question with one answer', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeClaudeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-board-completion-'));
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
            { name: 'carol', role: 'developer' },
          ],
        },
        null,
        2
      )
    );
    return dir;
  }

  function readInbox(claudeDir, member) {
    const file = path.join(claudeDir, 'teams', 'my-team', 'inboxes', `${member}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  }

  function boardNotices(claudeDir) {
    return readInbox(claudeDir, 'alice').filter((row) =>
      String(row.messageId || '').startsWith('board-complete:')
    );
  }

  function withClock(run) {
    const clock = { now: Date.parse('2026-09-02T09:00:00.000Z') };
    vi.useFakeTimers({ now: clock.now, toFake: ['Date'] });
    const advance = (minutes) => {
      clock.now += minutes * 60 * 1000;
      vi.setSystemTime(clock.now);
    };
    try {
      run(advance);
    } finally {
      vi.useRealTimers();
    }
  }

  it('does not keep the board open for a deleted task at either site', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    withClock((advance) => {
      const kept = controller.tasks.createTask({ subject: 'Write the summary', owner: 'bob' });
      const dropped = controller.tasks.createTask({ subject: 'Print the poster', owner: 'bob' });
      advance(1);
      controller.tasks.softDeleteTask(dropped.id, 'alice');
      advance(1);
      controller.tasks.completeTask(kept.id, 'bob');

      // The notice fires: a deleted task is not live work.
      const notices = boardNotices(claudeDir);
      expect(notices).toHaveLength(1);
      expect(notices[0].text).toContain('Board complete');

      advance(1);
      const final = controller.messages.sendMessage({
        to: 'user',
        from: 'alice',
        text: 'The summary is written; the poster task was dropped and the board is finished.',
      });
      expect(final.deduplicated).toBeUndefined();

      // Same board, same answer: the guard treats it as complete and holds the
      // restatement back.
      advance(2);
      const restated = controller.messages.sendMessage({
        to: 'user',
        from: 'alice',
        text: 'Everything you asked for is done, nothing else is pending on my side.',
      });
      expect(restated.deduplicated).toBe(true);
      expect(restated.duplicateOfMessageId).toBe(final.messageId);
      expect(restated.deduplicationNotice).toContain('Final message already delivered');
    });
  });

  it('keeps the board open at both sites while a completed task is in review', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    withClock((advance) => {
      const written = controller.tasks.createTask({ subject: 'Write the summary', owner: 'bob' });
      const checked = controller.tasks.createTask({ subject: 'Check the summary', owner: 'bob' });
      controller.tasks.completeTask(written.id, 'bob');
      controller.review.requestReview(written.id, { from: 'alice', reviewer: 'alice' });
      expect(controller.tasks.getTask(written.id)).toMatchObject({
        status: 'completed',
        reviewState: 'review',
      });

      advance(1);
      controller.tasks.completeTask(checked.id, 'bob');

      // Work in review is still work: no completion notice.
      expect(boardNotices(claudeDir)).toEqual([]);

      advance(1);
      const first = controller.messages.sendMessage({
        to: 'user',
        from: 'alice',
        text: 'The summary is written and is with the reviewer right now.',
      });
      expect(first.deduplicated).toBeUndefined();

      // And the guard stays out of the way, so the team can still report the
      // review outcome to the user.
      advance(2);
      const second = controller.messages.sendMessage({
        to: 'user',
        from: 'alice',
        text: 'The reviewer is through the first half; I will report again when it is signed off.',
      });
      expect(second.deduplicated).toBeUndefined();
      expect(readInbox(claudeDir, 'user')).toHaveLength(2);
    });
  });

  it('keeps the board open at both sites while a completed task waits for another review pass', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    withClock((advance) => {
      const written = controller.tasks.createTask({ subject: 'Write the summary', owner: 'bob' });
      const checked = controller.tasks.createTask({ subject: 'Check the summary', owner: 'bob' });
      controller.tasks.completeTask(written.id, 'bob');
      controller.review.requestReview(written.id, { from: 'alice', reviewer: 'alice' });
      controller.review.requestChanges(written.id, {
        from: 'alice',
        comment: 'The second section is missing.',
      });
      expect(controller.tasks.getTask(written.id)).toMatchObject({
        status: 'pending',
        reviewState: 'needsFix',
      });

      // The owner fixes it and completes it again: the task is completed but is
      // owed another review pass.
      advance(1);
      controller.tasks.completeTask(written.id, 'bob');
      expect(controller.tasks.getTask(written.id)).toMatchObject({
        status: 'completed',
        reviewState: 'needsFix',
      });

      advance(1);
      controller.tasks.completeTask(checked.id, 'bob');
      expect(boardNotices(claudeDir)).toEqual([]);

      advance(1);
      const first = controller.messages.sendMessage({
        to: 'user',
        from: 'alice',
        text: 'The missing section is written and the summary is back with the reviewer.',
      });
      expect(first.deduplicated).toBeUndefined();

      advance(2);
      const second = controller.messages.sendMessage({
        to: 'user',
        from: 'alice',
        text: 'The reviewer signed off on the first half, one more pass to go.',
      });
      expect(second.deduplicated).toBeUndefined();
      expect(readInbox(claudeDir, 'user')).toHaveLength(2);
    });
  });

  it.each([false, true])('delivers one final after approval (fix cycle: %s)', (needsFix) => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const send = (text) => controller.messages.sendMessage({ to: 'user', from: 'alice', text });
    withClock((advance) => {
      const task = controller.tasks.createTask({ subject: 'Sandbox review', owner: 'bob' });
      advance(1);
      controller.tasks.completeTask(task.id, 'bob');
      controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
      controller.review.startReview(task.id, { from: 'alice' });
      if (needsFix) {
        advance(1);
        controller.review.requestChanges(task.id, { from: 'alice', comment: 'Add evidence' });
        expect(send('The reviewer requested more evidence.').deduplicated).toBeUndefined();
        advance(1);
        controller.tasks.completeTask(task.id, 'bob');
        expect(controller.tasks.getTask(task.id).reviewState).toBe('needsFix');
        expect(send('The evidence is ready for another pass.').deduplicated).toBeUndefined();
        advance(1);
        controller.review.requestReview(task.id, { from: 'alice', reviewer: 'alice' });
        controller.review.startReview(task.id, { from: 'alice' });
      }
      advance(1);
      expect(send('Review is in progress.').deduplicated).toBeUndefined();
      advance(1);
      controller.review.approveReview(task.id, { from: 'alice', note: 'Evidence accepted' });
      advance(1);
      const final = send('Review approved. The result is ready.');
      expect(final.deduplicated).toBeUndefined();
      advance(1);
      expect(send('Everything is now finished.').duplicateOfMessageId).toBe(final.messageId);
      // Approval retries and metadata edits must not reset the guard.
      advance(1);
      expect(controller.review.approveReview(task.id, { from: 'alice' }).alreadyApproved).toBe(true);
      controller.tasks.addTaskComment(task.id, { from: 'alice', text: 'Archival note' });
      controller.tasks.addTaskAttachmentMeta(task.id, {
        id: 'sandbox-evidence',
        filename: 'evidence.txt',
        mimeType: 'text/plain',
        size: 0,
      });
      advance(1);
      expect(send('A recap of the approved result.').duplicateOfMessageId).toBe(final.messageId);
      expect(readInbox(claudeDir, 'user')).toHaveLength(needsFix ? 4 : 2);
    });
  });

  it('retains the updatedAt fallback for legacy tasks without history events', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const send = (text) => controller.messages.sendMessage({ to: 'user', from: 'alice', text });
    withClock((advance) => {
      const task = controller.tasks.createTask({ subject: 'Legacy sandbox task', owner: 'bob' });
      advance(1);
      send('Legacy work in progress.');
      advance(1);
      controller.tasks.updateTask(task.id, (persisted) => {
        persisted.status = 'completed';
        delete persisted.historyEvents;
        return persisted;
      });
      advance(1);
      const final = send('Legacy work done.');
      expect(final.deduplicated).toBeUndefined();
      advance(1);
      expect(send('Legacy final recap.').duplicateOfMessageId).toBe(final.messageId);
    });
  });

  const directMessage = (controller, from, to, text) =>
    controller.messages.sendMessage({ from, to, text });
  const answerAlice = (controller, from, request, text) =>
    controller.messages.sendMessage({
      from,
      to: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: request.messageId,
      text,
    });

  // A finished board whose final is already out; send() is the lead to the user.
  function completeBoard(controller, advance) {
    const send = (flags) =>
      controller.messages.sendMessage({ to: 'user', from: 'alice', ...flags });
    const task = controller.tasks.createTask({ subject: 'Write the file', owner: 'bob' });
    const early = directMessage(controller, 'alice', 'bob', 'Tell me when the file is written.');
    advance(1);
    controller.tasks.completeTask(task.id, 'bob');
    advance(1);
    const final = send({ text: 'The file is written and the board is complete.' });
    expect(final.deduplicated).toBeUndefined();
    return { send, task, early, final };
  }

  // Then the lead thanks bob unprompted, the user asks for one more thing, and
  // the lead passes it to bob by direct message rather than as a task.
  function askBobAfterCompletion(controller, advance) {
    const board = completeBoard(controller, advance);
    advance(1);
    const unprompted = directMessage(controller, 'alice', 'bob', 'Thanks bob, that is all.');
    advance(1);
    const followUp = directMessage(
      controller,
      'user',
      'alice',
      'Ask bob to append a third line, then tell me what the file holds.'
    );
    advance(1);
    const question = directMessage(
      controller,
      'alice',
      'bob',
      'Please append a third line and tell me what the file holds now.'
    );
    advance(1);
    const interim = board.send({
      source: 'runtime_delivery',
      relayOfMessageId: followUp.messageId,
      text: 'I asked bob to append the line and will pass on exactly what he reports.',
    });
    expect(interim.deduplicated).toBeUndefined();
    return { ...board, unprompted, question, interim };
  }

  it.each(['the answer', 'nothing', 'a status report'])(
    'delivers the relay of a teammate answer to the user follow-up (cites %s)',
    (cites) => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });
      withClock((advance) => {
        const { send, question } = askBobAfterCompletion(controller, advance);
        const status = directMessage(controller, 'carol', 'alice', 'Carol is idle.');
        advance(1);
        const answer = answerAlice(controller, 'bob', question, 'Appended; the file has 3 lines.');
        advance(1);
        const cited = { 'the answer': answer, nothing: null, 'a status report': status }[cites];
        const relay = send({
          ...(cited ? { source: 'runtime_delivery', relayOfMessageId: cited.messageId } : {}),
          text: 'Bob appended the third line; the file holds three lines now.',
        });
        expect(relay.deduplicated).toBeUndefined();

        // The answer is passed on once: a later recap restates it again.
        advance(1);
        const recap = send({ text: 'ALL DONE - the file holds three lines, nothing is pending.' });
        expect(recap.duplicateOfMessageId).toBe(relay.messageId);
        expect(readInbox(claudeDir, 'user')).toHaveLength(3);
      });
    }
  );

  it('delivers each cited answer when several teammates answer the follow-up', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    withClock((advance) => {
      const { send, task } = completeBoard(controller, advance);
      advance(1);
      const followUp = directMessage(controller, 'user', 'alice', 'Ask bob and carol for a line.');
      advance(1);
      const toBob = directMessage(controller, 'alice', 'bob', 'Bob, append a line, then tell me.');
      const toCarol = directMessage(controller, 'alice', 'carol', 'Carol, append one too.');
      advance(1);
      const fromBob = answerAlice(controller, 'bob', toBob, 'Bob appended his line.');
      advance(1);
      // Bob already answered before this interim went out.
      const interim = send({
        source: 'runtime_delivery',
        relayOfMessageId: followUp.messageId,
        text: 'I asked bob and carol and will pass on both answers.',
      });
      expect(interim.deduplicated).toBeUndefined();
      advance(1);
      const fromCarol = answerAlice(controller, 'carol', toCarol, 'Carol appended her line.');
      advance(1);
      const relays = [fromBob, fromCarol].map((reply) =>
        send({
          source: 'runtime_delivery',
          relayOfMessageId: reply.messageId,
          text: `Passing on: ${reply.message.text}`,
        })
      );
      expect(relays.map((relay) => relay.deduplicated)).toEqual([undefined, undefined]);

      // Citing an answer that was already passed on is a restatement, even with
      // task refs that the relay-scoped guard would treat as new context.
      advance(1);
      const repeat = send({
        relayOfMessageId: fromBob.messageId,
        taskRefs: [{ taskId: task.id, displayId: task.displayId, teamName: 'my-team' }],
        text: 'To recap: bob appended his line and the task is done.',
      });
      expect(repeat.duplicateOfMessageId).toBe(relays[1].messageId);
    });
  });

  it.each([true, false])(
    'holds back a recap after a teammate answers what the lead sent unprompted (cites it: %s)',
    (citesAnswer) => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });
      withClock((advance) => {
        const { send, final } = completeBoard(controller, advance);
        advance(1);
        const thanks = directMessage(controller, 'alice', 'bob', 'Thanks bob, that is all.');
        advance(1);
        const reply = answerAlice(controller, 'bob', thanks, 'Glad it worked, nothing else here.');
        advance(1);
        const recap = send({
          ...(citesAnswer ? { relayOfMessageId: reply.messageId } : {}),
          text: 'ALL DONE - the file is written and nothing is pending.',
        });
        expect(recap.duplicateOfMessageId).toBe(final.messageId);
      });
    }
  );

  it.each([
    'status report without a relay',
    'system notification',
    'reply to a task notification',
    'reply to a pre-completion message',
    'reply to a message sent before the follow-up',
    "reply to another member's message",
  ])('still holds back a restated final after a teammate %s', (kind) => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    withClock((advance) => {
      const { send, early, unprompted, question, interim } = askBobAfterCompletion(
        controller,
        advance
      );
      const assignment = readInbox(claudeDir, 'bob').find(
        (row) => row.source === 'system_notification'
      );
      expect(assignment).toMatchObject({ from: 'alice', to: 'bob' });
      const fromCarol = directMessage(controller, 'carol', 'bob', 'Bob, what does it hold?');
      const relayOfMessageId = {
        'status report without a relay': undefined,
        'system notification': question.messageId,
        'reply to a task notification': assignment.messageId,
        'reply to a pre-completion message': early.messageId,
        'reply to a message sent before the follow-up': unprompted.messageId,
        "reply to another member's message": fromCarol.messageId,
      }[kind];
      advance(1);
      const reply = controller.messages.sendMessage({
        to: 'alice',
        from: 'bob',
        source: kind === 'system notification' ? 'system_notification' : 'runtime_delivery',
        ...(relayOfMessageId ? { relayOfMessageId } : {}),
        text: 'The file is written and my task is complete.',
      });
      // Citing that reply does not make it an answer to the follow-up either.
      for (const cited of [undefined, reply.messageId]) {
        advance(1);
        const recap = send({
          ...(cited ? { relayOfMessageId: cited } : {}),
          text: 'ALL DONE - the file is written and nothing is pending.',
        });
        expect(recap.deduplicated).toBe(true);
        expect(recap.duplicateOfMessageId).toBe(interim.messageId);
      }
    });
  });

  it('routes both sites through the shared predicate instead of restating the rule', () => {
    const internalDir = path.join(__dirname, '..', 'src', 'internal');
    const messageStoreSource = fs.readFileSync(path.join(internalDir, 'messageStore.js'), 'utf8');
    const tasksSource = fs.readFileSync(path.join(internalDir, 'tasks.js'), 'utf8');

    expect(messageStoreSource).toContain("require('./taskLifecycle.js')");
    expect(tasksSource).toContain("require('./taskLifecycle.js')");
    // Neither site may re-derive the rule: restating it is how the two drifted
    // apart in the first place.
    expect(messageStoreSource).not.toContain("status === 'completed'");
    expect(tasksSource).not.toContain("reviewState === 'review'");
  });
});
