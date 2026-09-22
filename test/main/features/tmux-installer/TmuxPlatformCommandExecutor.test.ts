import { parseRuntimeProcessTable } from '@features/tmux-installer/main';
import { describe, expect, it } from 'vitest';

describe('parseRuntimeProcessTable', () => {
  it('parses pid, ppid and command rows', () => {
    expect(
      parseRuntimeProcessTable('  10   1 /bin/zsh\n  11  10 node runtime --team-name demo')
    ).toEqual([
      { pid: 10, ppid: 1, command: '/bin/zsh' },
      { pid: 11, ppid: 10, command: 'node runtime --team-name demo' },
    ]);
  });

  it('parses optional cpu and rss columns', () => {
    expect(
      parseRuntimeProcessTable('  10   1  3.5  120000 /bin/zsh\n  11  10  0.1  42 node demo')
    ).toEqual([
      { pid: 10, ppid: 1, command: '/bin/zsh', cpuPercent: 3.5, rssBytes: 122_880_000 },
      { pid: 11, ppid: 10, command: 'node demo', cpuPercent: 0.1, rssBytes: 43_008 },
    ]);
  });

  it('skips malformed rows', () => {
    expect(parseRuntimeProcessTable('bad\n  0  1 nope\n  12  0 /bin/node')).toEqual([
      { pid: 12, ppid: 0, command: '/bin/node' },
    ]);
  });
});
