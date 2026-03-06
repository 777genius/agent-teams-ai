import { describe, it, expect, vi } from 'vitest';
import { TeamctlRunner } from '../src/teamctl-runner.js';
import type { ITeamctlRunner, TeamctlResult } from '../src/teamctl-runner.js';

// We can't easily test the real subprocess without teamctl.js installed,
// so we test the interface contract and error handling.

describe('TeamctlRunner', () => {
  it('throws if teamctl.js does not exist', () => {
    expect(
      () => new TeamctlRunner({ teamctlPath: '/nonexistent/teamctl.js' }),
    ).toThrow('teamctl.js not found');
  });

  it('resolves path from TEAMCTL_PATH env', () => {
    const original = process.env['TEAMCTL_PATH'];
    try {
      process.env['TEAMCTL_PATH'] = '/tmp/test-teamctl.js';
      // Will throw because file doesn't exist, but we can check the error message
      expect(
        () => new TeamctlRunner(),
      ).toThrow('/tmp/test-teamctl.js');
    } finally {
      if (original !== undefined) {
        process.env['TEAMCTL_PATH'] = original;
      } else {
        delete process.env['TEAMCTL_PATH'];
      }
    }
  });
});

// Mock runner for tool tests
export function createMockRunner(
  responses: Map<string, TeamctlResult> | TeamctlResult,
): ITeamctlRunner {
  return {
    execute: vi.fn(async (args: string[]): Promise<TeamctlResult> => {
      if (responses instanceof Map) {
        const key = args.join(' ');
        const result = responses.get(key);
        if (result) return result;
        // Fallback: check if any key is a prefix
        for (const [k, v] of responses) {
          if (key.startsWith(k)) return v;
        }
        return { stdout: '', stderr: 'No mock for: ' + key, exitCode: 1 };
      }
      return responses;
    }),
  };
}

describe('ITeamctlRunner interface', () => {
  it('mock runner returns success', async () => {
    const runner = createMockRunner({
      stdout: '{"id":"1","subject":"Test"}\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await runner.execute(['--team', 'test', 'task', 'create']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('id', '1');
  });

  it('mock runner returns error', async () => {
    const runner = createMockRunner({
      stdout: '',
      stderr: 'Task not found: #99\n',
      exitCode: 1,
    });

    const result = await runner.execute(['--team', 'test', 'task', 'get', '99']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Task not found');
  });
});
