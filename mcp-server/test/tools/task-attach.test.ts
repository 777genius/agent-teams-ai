import { describe, it, expect } from 'vitest';
import { register } from '../../src/tools/task-attach.js';
import { createMockRunner, createMockServer, ok, fail } from './test-helpers.js';

describe('task_attach', () => {
  const attachJson = '{"id":"att_123","filename":"report.pdf","mimeType":"application/pdf"}';

  function setup(response = ok(attachJson)) {
    const runner = createMockRunner(response);
    const { server, tools } = createMockServer();
    register(server, runner);
    return { runner, tool: tools.get('task_attach')! };
  }

  it('builds minimal CLI args', async () => {
    const { runner, tool } = setup();
    await tool.execute({ team: 'acme', task_id: '1', file: '/tmp/report.pdf' });
    expect(runner.execute).toHaveBeenCalledWith([
      '--team', 'acme', 'task', 'attach', '1', '--file', '/tmp/report.pdf',
    ]);
  });

  it('includes all optional flags', async () => {
    const { runner, tool } = setup();
    await tool.execute({
      team: 'acme', task_id: '1', file: '/tmp/file.pdf',
      filename: 'renamed.pdf', mime_type: 'application/pdf',
      mode: 'link', from: 'alice',
    });
    const args = runner.execute.mock.calls[0]![0] as string[];
    expect(args).toContain('--filename');
    expect(args).toContain('--mime-type');
    expect(args).toContain('--mode');
    expect(args).toContain('--from');
  });

  it('returns parsed JSON', async () => {
    const { tool } = setup();
    const result = await tool.execute({ team: 'acme', task_id: '1', file: '/tmp/report.pdf' });
    expect(result).toEqual({ id: 'att_123', filename: 'report.pdf', mimeType: 'application/pdf' });
  });

  it('throws on CLI failure', async () => {
    const { tool } = setup(fail('file too large'));
    await expect(
      tool.execute({ team: 'acme', task_id: '1', file: '/tmp/huge.bin' }),
    ).rejects.toThrow('Failed to attach file');
  });
});
