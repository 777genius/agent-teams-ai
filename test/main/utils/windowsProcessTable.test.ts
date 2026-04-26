import { describe, expect, it } from 'vitest';

import { parseWindowsProcessTableJson } from '../../../src/main/utils/windowsProcessTable';

describe('windowsProcessTable', () => {
  it('parses PowerShell process table JSON objects and arrays', () => {
    expect(
      parseWindowsProcessTableJson(
        JSON.stringify([
          {
            ProcessId: 101,
            ParentProcessId: 1,
            CommandLine: 'node runtime --team-name demo --agent-id agent-a',
          },
          {
            ProcessId: '102',
            ParentProcessId: '101',
            CommandLine: 'opencode serve',
          },
          {
            ProcessId: 103,
            ParentProcessId: 1,
            CommandLine: null,
          },
        ])
      )
    ).toEqual([
      { pid: 101, ppid: 1, command: 'node runtime --team-name demo --agent-id agent-a' },
      { pid: 102, ppid: 101, command: 'opencode serve' },
    ]);

    expect(
      parseWindowsProcessTableJson(
        JSON.stringify({
          ProcessId: 201,
          ParentProcessId: 1,
          CommandLine: 'claude --team-name demo --agent-id agent-b',
        })
      )
    ).toEqual([{ pid: 201, ppid: 1, command: 'claude --team-name demo --agent-id agent-b' }]);
  });
});
