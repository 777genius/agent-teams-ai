import { describe, expect, it } from 'vitest';

import { sortProjectGroupsByPin } from '../../../src/renderer/utils/taskGrouping';

import type { ProjectTaskGroup } from '../../../src/renderer/utils/taskGrouping';
import type { GlobalTask } from '../../../src/shared/types';

function group(projectKey: string, projectLabel: string): ProjectTaskGroup {
  return {
    projectKey,
    projectLabel,
    tasks: [{ id: projectKey } as GlobalTask],
  };
}

describe('sortProjectGroupsByPin', () => {
  it('keeps freshness order when nothing is pinned', () => {
    const groups = [group('/fresh', 'fresh'), group('/stale', 'stale')];

    expect(sortProjectGroupsByPin(groups, new Set()).map((item) => item.projectKey)).toEqual([
      '/fresh',
      '/stale',
    ]);
  });

  it('moves pinned folders ahead of unpinned ones and preserves order within each cohort', () => {
    const groups = [
      group('/fresh', 'fresh'),
      group('/pinned-stale', 'pinned-stale'),
      group('/also-pinned', 'also-pinned'),
      group('/older', 'older'),
    ];

    expect(
      sortProjectGroupsByPin(groups, new Set(['/pinned-stale', '/also-pinned'])).map(
        (item) => item.projectKey
      )
    ).toEqual(['/pinned-stale', '/also-pinned', '/fresh', '/older']);
  });
});
