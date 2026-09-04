const fs = require('fs');
const os = require('os');
const path = require('path');
const { createController } = require('../src/index.js');

describe('completed-board direct reply identity', () => {
  let claudeDir;
  let controller;

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-direct-reply-test-'));
    const teamDir = path.join(claudeDir, 'teams', 'sandbox');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify({
      name: 'sandbox', members: [{ name: 'alice', role: 'team-lead' }, { name: 'bob', role: 'developer' }],
    }));
    vi.useFakeTimers({ now: Date.parse('2026-09-04T14:00:00Z'), toFake: ['Date'] });
    controller = createController({ teamName: 'sandbox', claudeDir });
    const task = controller.tasks.createTask({ subject: 'Sandbox task', owner: 'alice', notifyOwner: false });
    controller.tasks.startTask(task.id, 'alice');
    controller.tasks.completeTask(task.id, 'alice');
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  function request(to, messageId, source = 'user_sent') {
    return controller.messages.sendMessage({
      from: 'user', to, messageId, source, text: `Please answer ${messageId}`,
      timestamp: '2026-09-04T14:01:00Z',
    });
  }

  function reply(from, relayOfMessageId, text = 'Result', timestamp = '2026-09-04T14:02:00Z') {
    return controller.messages.sendMessage({
      from, to: 'user', source: 'runtime_delivery', relayOfMessageId, text, timestamp,
    });
  }

  it('delivers different actors replies to requests queued before either reply', () => {
    request('alice', 'alice-request');
    request('bob', 'bob-request');
    const first = reply('alice', 'alice-request');
    const second = reply('bob', 'bob-request', 'Different result');
    expect(first.deduplicated).toBeUndefined();
    expect(second.deduplicated).toBeUndefined();
    expect(second.message).toMatchObject({ from: 'bob', relayOfMessageId: 'bob-request', text: 'Different result' });
  });

  it.each(['user_sent', null])('delivers a distinct pending human request to the same actor (%s)', (source) => {
    request('alice', 'first-request');
    request('alice', 'second-request', source);
    reply('alice', 'first-request');
    expect(reply('alice', 'second-request').deduplicated).toBeUndefined();
    const repeat = reply('alice', 'second-request', 'Result again');
    expect(repeat.deduplicated).toBe(true);
    expect(repeat.message.relayOfMessageId).toBe('second-request');
  });

  it('does not bypass final recap suppression with an ambiguous request id', () => {
    request('alice', 'actual-request');
    request('alice', 'ambiguous-request');
    request('bob', 'ambiguous-request');
    const first = reply('alice', 'actual-request');
    const result = reply('alice', 'ambiguous-request', 'Recap');
    expect(result.deduplicated).toBe(true);
    expect(result.duplicateOfMessageId).toBe(first.messageId);
  });

  it.each(['alice', 'bob', undefined])('validates explicit recipient on stdin-delivered requests (%s)', (to) => {
    request('alice', 'actual-request');
    controller.messages.appendSentMessage({
      from: 'user', to, messageId: 'stdin-request', source: 'user_sent', text: 'Direct request to lead',
      timestamp: '2026-09-04T14:01:00Z',
    });
    const first = reply('alice', 'actual-request');
    const result = reply('alice', 'stdin-request', 'Direct reply');
    if (to === 'alice') {
      expect(result.deduplicated).toBeUndefined();
    } else {
      expect(result.duplicateOfMessageId).toBe(first.messageId);
    }
  });

  it('deduplicates same actor same relay retries and uncorrelated final recaps', () => {
    request('alice', 'request');
    const first = reply('alice', 'request');
    expect(reply('alice', 'request').duplicateOfMessageId).toBe(first.messageId);
    expect(reply('alice', 'request', 'Rephrased result').duplicateOfMessageId).toBe(first.messageId);
    expect(reply('alice', undefined, 'All done recap').duplicateOfMessageId).toBe(first.messageId);
  });

  it.each(['missing-request', 'other-actor-request', 'system-request', 'future-request'])(
    'does not bypass final recap suppression with unproven relay %s', (relay) => {
      request('alice', 'actual-request');
      request('bob', 'other-actor-request');
      request('alice', 'system-request', 'system_notification');
      controller.messages.sendMessage({
        from: 'user', to: 'alice', messageId: 'future-request', source: 'user_sent',
        text: 'Future request', timestamp: '2026-09-04T14:01:30Z',
      });
      const first = reply('alice', 'actual-request');
      const result = reply('alice', relay, 'Rephrased final result',
        relay === 'future-request' ? '2026-09-04T14:01:15Z' : '2026-09-04T14:03:00Z');
      expect(result.deduplicated).toBe(true);
      expect(result.duplicateOfMessageId).toBe(first.messageId);
    },
  );
});
