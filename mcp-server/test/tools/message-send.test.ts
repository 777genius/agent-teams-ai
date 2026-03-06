import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/message-send.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('message_send', () => {
  const deliveryJson = '{"deliveredToInbox":true,"messageId":"msg_abc"}';

  function setup(response = ok(deliveryJson)) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('message_send')! };
  }

  it('builds minimal CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', to: 'alice', text: 'Hello!' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'message', 'send', '--to', 'alice', '--text', 'Hello!',
    ]);
  });

  it('includes summary and from flags', async () => {
    const { runner, tool } = setup();
    await tool.execute({
      team: 'acme', to: 'alice', text: 'Task done',
      summary: 'Completed task #1', from: 'bob',
    });
    const args = runner.execute.mock.calls[0]![0] as string[];
    expect(args).toContain('--summary');
    expect(args[args.indexOf('--summary') + 1]).toBe('Completed task #1');
    expect(args).toContain('--from');
    expect(args[args.indexOf('--from') + 1]).toBe('bob');
  });

  it('returns parsed JSON', async () => {
    const { tool } = setup();
    const result = await tool.execute({ team: 'acme', to: 'alice', text: 'Hello!' });
    expect(result).toEqual({ deliveredToInbox: true, messageId: 'msg_abc' });
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('recipient inbox not found'));
    await expect(
      tool.execute({ team: 'acme', to: 'nobody', text: 'Hi' }),
    ).rejects.toThrow('Failed to send message');
  });
});
