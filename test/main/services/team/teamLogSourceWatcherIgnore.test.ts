import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { shouldIgnoreLogSourceWatcherPath } from '../../../../src/main/services/team/teamLogSourceWatcherIgnore';

describe('shouldIgnoreLogSourceWatcherPath', () => {
  it('ignores internal ledger artifact paths but keeps freshness signals visible', () => {
    const projectDir = '/tmp/demo-project';
    const scopedSessionIds = new Set(['lead-session']);

    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, '.board-task-changes', 'events', 'task.jsonl')
      )
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, '.board-task-changes', 'locks', 'task.lock', 'owner.json')
      )
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, '.board-task-change-freshness', 'task.json')
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, '.board-task-log-freshness', 'task.json'),
        { scopedSessionIds }
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'lead-session.jsonl'),
        { scopedSessionIds }
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(projectDir, path.join(projectDir, 'old-session.jsonl'), {
        scopedSessionIds,
      })
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'pending-session.jsonl'),
        {
          scopedSessionIds,
          pendingRootSessionIds: new Set(['pending-session']),
        }
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(projectDir, path.join(projectDir, 'lead-session'), {
        scopedSessionIds,
      })
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(projectDir, path.join(projectDir, 'pending-session'), {
        scopedSessionIds,
        pendingRootSessionIds: new Set(['pending-session']),
      })
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(projectDir, path.join(projectDir, 'old-session'), {
        scopedSessionIds,
      })
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'lead-session', 'subagents', 'agent-worker.jsonl'),
        { scopedSessionIds }
      )
    ).toBe(false);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'lead-session', 'subagents', 'agent-acompact-worker.jsonl'),
        { scopedSessionIds }
      )
    ).toBe(true);
    expect(
      shouldIgnoreLogSourceWatcherPath(
        projectDir,
        path.join(projectDir, 'old-session', 'subagents', 'agent-worker.jsonl'),
        { scopedSessionIds }
      )
    ).toBe(true);
  });
});
