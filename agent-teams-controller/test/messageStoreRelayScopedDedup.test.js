const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

describe('relay-scoped user restatement dedup', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeClaudeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-relay-dedup-'));
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

  function readUserInbox(claudeDir) {
    return JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'user.json'), 'utf8')
    );
  }

  it('suppresses a paraphrased second answer for the same app-delivered message', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const first = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'Created three tasks and assigned the report section to bob.',
    });
    expect(first.deduplicated).toBeUndefined();

    const paraphrase = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'I have set up three tasks; bob now owns the report section.',
    });

    expect(paraphrase.deduplicated).toBe(true);
    expect(paraphrase.duplicateOfMessageId).toBe(first.messageId);
    expect(paraphrase.deduplicationNotice).toContain('relayOfMessageId');
    expect(readUserInbox(claudeDir)).toHaveLength(1);
  });

  it('lets a real answer land after an acknowledgement-only reply', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const ack = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'Понял',
    });
    expect(ack.deduplicated).toBeUndefined();

    const answer = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'Created three tasks and assigned the report section to bob.',
    });

    expect(answer.deduplicated).toBeUndefined();
    expect(readUserInbox(claudeDir)).toHaveLength(2);
  });

  // The app demands a real answer after every reply its own narrow-ack
  // vocabulary classifies ack-only (ACK_ONLY_PHRASES / ACK_ONLY_PREFIXES in
  // src/main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog.ts);
  // the escape here must recognise all of them or that answer is discarded.
  it.each(['Will do.', 'Сделаю', 'Разберусь', "I'll take a look", 'Я проверю', 'Understood'])(
    'lets the repaired answer land after the app-classified ack-only reply %j',
    (ackText) => {
      const claudeDir = makeClaudeDir();
      const controller = createController({ teamName: 'my-team', claudeDir });
      const ack = controller.messages.sendMessage({
        to: 'user',
        from: 'alice',
        source: 'runtime_delivery',
        relayOfMessageId: 'launch-1',
        text: ackText,
      });
      expect(ack.deduplicated).toBeUndefined();

      const answer = controller.messages.sendMessage({
        to: 'user',
        from: 'alice',
        source: 'runtime_delivery',
        relayOfMessageId: 'launch-1',
        text: 'Created three tasks and assigned the report section to bob.',
      });

      expect(answer.deduplicated).toBeUndefined();
      expect(readUserInbox(claudeDir)).toHaveLength(2);
    }
  );

  it('lets a reply carrying the required task refs land after one without them', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Write the report', owner: 'bob' });
    const withoutRefs = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'Created the report task and assigned it to bob.',
    });
    expect(withoutRefs.deduplicated).toBeUndefined();

    const withRefs = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: `Created the report task ${task.displayId} and assigned it to bob.`,
      taskRefs: [{ taskId: task.id, displayId: task.displayId, teamName: 'my-team' }],
    });

    expect(withRefs.deduplicated).toBeUndefined();
    expect(readUserInbox(claudeDir)).toHaveLength(2);
  });

  it('suppresses a second reply once the first already carries the required task refs', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Write the report', owner: 'bob' });
    const taskRefs = [{ taskId: task.id, displayId: task.displayId, teamName: 'my-team' }];
    const first = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'Created the report task and assigned it to bob.',
      taskRefs,
    });
    expect(first.deduplicated).toBeUndefined();

    const paraphrase = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'The report task is on the board and bob owns it.',
      taskRefs,
    });

    expect(paraphrase.deduplicated).toBe(true);
    expect(readUserInbox(claudeDir)).toHaveLength(1);
  });

  it('respects the 30 minute window', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const old = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'Created three tasks and assigned the report section to bob.',
      timestamp: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    });
    expect(old.deduplicated).toBeUndefined();

    const later = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      source: 'runtime_delivery',
      relayOfMessageId: 'launch-1',
      text: 'I have set up three tasks; bob now owns the report section.',
    });

    expect(later.deduplicated).toBeUndefined();
    expect(readUserInbox(claudeDir)).toHaveLength(2);
  });

  it('never scopes the rule to messages without a relayOfMessageId or to teammate recipients', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });
    const first = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      text: 'Created three tasks and assigned the report section to bob.',
    });
    const paraphrase = controller.messages.sendMessage({
      to: 'user',
      from: 'alice',
      text: 'I have set up three tasks; bob now owns the report section.',
    });
    expect(first.deduplicated).toBeUndefined();
    expect(paraphrase.deduplicated).toBeUndefined();

    const toMember = controller.messages.sendMessage({
      to: 'bob',
      from: 'alice',
      relayOfMessageId: 'launch-1',
      text: 'Start with the report outline please.',
    });
    const toMemberAgain = controller.messages.sendMessage({
      to: 'bob',
      from: 'alice',
      relayOfMessageId: 'launch-1',
      text: 'Please begin with the outline of the report.',
    });
    expect(toMember.deduplicated).toBeUndefined();
    expect(toMemberAgain.deduplicated).toBeUndefined();
  });
});
