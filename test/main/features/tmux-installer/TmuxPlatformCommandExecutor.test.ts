import { describe, expect, it } from 'vitest';

import { parseRuntimeProcessTable } from '@features/tmux-installer/main';

describe('parseRuntimeProcessTable', () => {
  it('parses pid, ppid and command rows', () => {
    expect(
      parseRuntimeProcessTable('  10   1 /bin/zsh\n  11  10 node runtime --team-name demo')
    ).toEqual([
      { pid: 10, ppid: 1, command: '/bin/zsh' },
      { pid: 11, ppid: 10, command: 'node runtime --team-name demo' },
    ]);
  });

  it('skips malformed rows', () => {
    expect(parseRuntimeProcessTable('bad\n  0  1 nope\n  12  0 /bin/node')).toEqual([
      { pid: 12, ppid: 0, command: '/bin/node' },
    ]);
  });
});
