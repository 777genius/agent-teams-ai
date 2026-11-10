import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildTeamLogWatchSessionIds,
  classifyLogSourceWatcherEvent,
  extractRuntimeSessionIds,
  normalizeLogSourceSessionId,
} from '../../../../src/main/services/team/teamLogSourceWatchScope';

describe('teamLogSourceWatchScope', () => {
  it('builds a bounded confirmed session scope with lead, runtime ids, and newest history first', () => {
    const ids = buildTeamLogWatchSessionIds({
      configLeadSessionId: 'lead-session',
      launchLeadSessionId: 'lead-session',
      launchRuntimeSessionIds: ['runtime-bob'],
      sessionHistory: ['old-session', 'recent-session', 'lead-session'],
    });

    expect(ids).toEqual(['lead-session', 'runtime-bob', 'recent-session', 'old-session']);
  });

  it('normalizes session ids defensively', () => {
    expect(normalizeLogSourceSessionId(' valid_id-1 ')).toBe('valid_id-1');
    expect(normalizeLogSourceSessionId('')).toBeNull();
    expect(normalizeLogSourceSessionId('../escape')).toBeNull();
    expect(normalizeLogSourceSessionId('with/slash')).toBeNull();
  });

  it('extracts runtime session ids from launch members that can still write early logs', () => {
    const ids = extractRuntimeSessionIds({
      members: {
        pending: {
          launchState: 'runtime_pending_bootstrap',
          runtimeSessionId: 'runtime-pending',
          hardFailure: false,
        },
        failed: {
          launchState: 'failed_to_start',
          runtimeSessionId: 'runtime-failed',
          hardFailure: true,
        },
      },
    } as never);

    expect(ids).toEqual(['runtime-pending']);
  });

  it('classifies unknown, pending, scoped, and ignored watcher events', () => {
    const projectDir = '/tmp/project';
    const scopedSessionIds = new Set(['lead-session']);
    const pendingUnknownSessionIds = new Set(['new-runtime']);

    expect(
      classifyLogSourceWatcherEvent({
        projectDir,
        changedPath: path.join(projectDir, 'old-session.jsonl'),
        eventName: 'change',
        scopedSessionIds,
        pendingUnknownSessionIds,
      })
    ).toEqual({ kind: 'ignore' });

    expect(
      classifyLogSourceWatcherEvent({
        projectDir,
        changedPath: path.join(projectDir, 'new-runtime.jsonl'),
        eventName: 'change',
        scopedSessionIds,
        pendingUnknownSessionIds,
      })
    ).toEqual({ kind: 'context-refresh', candidateSessionId: 'new-runtime' });

    expect(
      classifyLogSourceWatcherEvent({
        projectDir,
        changedPath: path.join(projectDir, 'lead-session', 'subagents', 'agent-worker.jsonl'),
        eventName: 'change',
        scopedSessionIds,
        pendingUnknownSessionIds,
      })
    ).toEqual({ kind: 'scoped-recompute' });

    expect(
      classifyLogSourceWatcherEvent({
        projectDir,
        changedPath: path.join(projectDir, 'lead-session', 'subagents', 'agent-acompact-x.jsonl'),
        eventName: 'change',
        scopedSessionIds,
        pendingUnknownSessionIds,
      })
    ).toEqual({ kind: 'ignore' });
  });
});
