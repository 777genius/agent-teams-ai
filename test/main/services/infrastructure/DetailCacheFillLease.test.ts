import { DataCache } from '@main/services/infrastructure/DataCache';
import { describe, expect, it } from 'vitest';

import type { SessionDetail, SubagentDetail } from '@main/types';

function detail(label: string): SessionDetail {
  return {
    session: {
      id: 'session-a',
      projectId: 'sandbox',
      projectPath: '/synthetic-test/sandbox',
      createdAt: 1,
      firstMessage: label,
      hasSubagents: false,
      messageCount: 0,
    },
    messages: [],
    chunks: [],
    processes: [],
    metrics: {
      durationMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 0,
    },
  };
}

function subagent(): SubagentDetail {
  return {
    id: 'agent-a',
    description: 'sandbox agent',
    chunks: [],
    startTime: new Date(0),
    endTime: new Date(1),
    duration: 1,
    metrics: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, messageCount: 0 },
  };
}

describe('detail cache fill ownership', () => {
  // These fail if old work can repopulate an invalidated cache or regain a newer writer's permission.
  it('rejects a fill invalidated before its first cache entry exists', () => {
    const cache = new DataCache();
    const fill = cache.beginSessionFill('sandbox', 'session-a');
    cache.invalidateSession('sandbox', 'session-a');
    expect(fill.isSourceCurrent()).toBe(false);
    expect(fill.commit(detail('stale'))).toBe(false);
    expect(cache.get('sandbox/session-a')).toBeUndefined();
    fill.release();
  });

  it('never restores an old writer after the newest writer settles', () => {
    const cache = new DataCache();
    const older = cache.beginSessionFill('sandbox', 'session-a');
    const newest = cache.beginSessionFill('sandbox', 'session-a');
    const value = detail('newest');
    expect(newest.commit(value)).toBe(true);
    newest.release();
    expect(older.isSourceCurrent()).toBe(true);
    expect(older.commit(detail('older'))).toBe(false);
    expect(cache.get('sandbox/session-a')).toBe(value);
    older.release();
  });

  it('does not revive the older writer when a newer read fails or returns null', () => {
    const cache = new DataCache();
    const older = cache.beginSessionFill('sandbox', 'session-a');
    const failed = cache.beginSessionFill('sandbox', 'session-a');
    failed.release();
    expect(older.commit(detail('older'))).toBe(false);
    older.release();
    const fresh = cache.beginSessionFill('sandbox', 'session-a');
    expect(fresh.commit(detail('fresh'))).toBe(true);
    fresh.release();
  });

  it('fences disable and re-enable without failing a valid uncached read', () => {
    const cache = new DataCache();
    const fill = cache.beginSessionFill('sandbox', 'session-a');
    cache.setEnabled(false);
    cache.setEnabled(true);
    expect(fill.isSourceCurrent()).toBe(true);
    expect(fill.commit(detail('old-permission'))).toBe(false);
    fill.release();
    const fresh = cache.beginSessionFill('sandbox', 'session-a');
    expect(fresh.commit(detail('fresh'))).toBe(true);
    fresh.release();
  });

  it('keeps an unrelated read valid while conservatively fencing its cache commit', () => {
    const cache = new DataCache();
    const preserved = detail('preserved');
    cache.set('other/session-b', preserved);
    const unrelated = cache.beginSessionFill('other', 'session-c');
    cache.invalidateSession('sandbox', 'session-a');
    expect(unrelated.isSourceCurrent()).toBe(true);
    expect(unrelated.commit(detail('uncached'))).toBe(false);
    expect(cache.get('other/session-b')).toBe(preserved);
    unrelated.release();
  });

  it('covers composite projects and subagent fills without a pre-existing entry', () => {
    const cache = new DataCache();
    const session = cache.beginSessionFill('sandbox::worktree', 'session-a');
    const agent = cache.beginSubagentFill('sandbox::worktree', 'session-a', 'agent-a');
    const other = cache.beginSubagentFill('other', 'session-a', 'agent-a');
    cache.invalidateSession('sandbox', 'session-a');
    expect(session.isSourceCurrent()).toBe(false);
    expect(agent.isSourceCurrent()).toBe(false);
    expect(other.isSourceCurrent()).toBe(true);
    expect(agent.commit(subagent())).toBe(false);
    session.release();
    agent.release();
    other.release();
  });

  it('subagent-only invalidation keeps the parent session read valid', () => {
    const cache = new DataCache();
    const session = cache.beginSessionFill('sandbox', 'session-a');
    const agent = cache.beginSubagentFill('sandbox', 'session-a', 'agent-a');
    cache.invalidateSubagentSession('sandbox', 'session-a');
    expect(session.isSourceCurrent()).toBe(true);
    expect(agent.isSourceCurrent()).toBe(false);
    session.release();
    agent.release();
  });

  it('project invalidation and clear also close fills with no cached entry', () => {
    const cache = new DataCache();
    const project = cache.beginSessionFill('sandbox::worktree', 'session-a');
    cache.invalidateProject('sandbox');
    expect(project.isSourceCurrent()).toBe(false);
    const other = cache.beginSessionFill('other', 'session-b');
    cache.clear();
    expect(other.isSourceCurrent()).toBe(false);
    project.release();
    other.release();
  });

  it('a synchronous cache writer supersedes an outstanding fill', () => {
    const cache = new DataCache();
    const fill = cache.beginSessionFill('sandbox', 'session-a');
    const value = detail('synchronous');
    cache.set('sandbox/session-a', value);
    expect(fill.isSourceCurrent()).toBe(true);
    expect(fill.commit(detail('stale'))).toBe(false);
    expect(cache.get('sandbox/session-a')).toBe(value);
    fill.release();
  });

  it('disposal is terminal and released fills cannot commit again', () => {
    const cache = new DataCache();
    const fill = cache.beginSessionFill('sandbox', 'session-a');
    cache.dispose();
    cache.setEnabled(true);
    expect(cache.isEnabled()).toBe(false);
    expect(fill.isSourceCurrent()).toBe(false);
    expect(fill.commit(detail('disposed'))).toBe(false);
    fill.release();
    fill.release();
    const after = cache.beginSessionFill('sandbox', 'session-a');
    expect(after.isSourceCurrent()).toBe(false);
    expect(after.commit(detail('after-dispose'))).toBe(false);
    after.release();
  });
});
