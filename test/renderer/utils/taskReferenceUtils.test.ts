import { describe, expect, it } from 'vitest';

import {
  buildTaskLinkHref,
  linkifyTaskIdsInMarkdown,
  parseTaskLinkHref,
} from '@renderer/utils/taskReferenceUtils';

import type { TaskRef } from '@shared/types';

describe('taskReferenceUtils', () => {
  describe('TASK_REF_REGEX and isAllowedTaskRefBoundary', () => {
    it('linkifies #ref when preceded by boundary (space, start)', () => {
      const taskRef: TaskRef = {
        taskId: 't1',
        displayId: 'task-1',
        teamName: 'my-team',
      };
      const r = linkifyTaskIdsInMarkdown('see #task-1 done', [taskRef]);
      expect(r).toContain('task://');
      expect(r).toContain('[#task-1]');
    });

    it('does NOT linkify #ref when preceded by word char', () => {
      const taskRef: TaskRef = {
        taskId: 't1',
        displayId: 'task1',
        teamName: 'my-team',
      };
      const r = linkifyTaskIdsInMarkdown('x#task1', [taskRef]);
      expect(r).toBe('x#task1');
    });

    it('linkifies #ref with hyphen in id', () => {
      const r = linkifyTaskIdsInMarkdown(' #abc-123 ');
      expect(r).toContain('task://');
    });
  });

  describe('buildTaskLinkHref and parseTaskLinkHref', () => {
    it('roundtrips task ref', () => {
      const ref: TaskRef = {
        taskId: 'tid-1',
        displayId: 'T-1',
        teamName: 'team-a',
      };
      const href = buildTaskLinkHref(ref);
      expect(href).toContain('task://');
      expect(href).toContain('team=');
      expect(href).toContain('display=');

      const parsed = parseTaskLinkHref(href);
      expect(parsed).toEqual({
        taskId: 'tid-1',
        teamName: 'team-a',
        displayId: 'T-1',
      });
    });

    it('parseTaskLinkHref returns null for non-task URL', () => {
      expect(parseTaskLinkHref('https://example.com')).toBeNull();
      expect(parseTaskLinkHref('mention://x')).toBeNull();
    });

    it('parseTaskLinkHref handles task:// without query', () => {
      const r = parseTaskLinkHref('task://tid-1');
      expect(r).toEqual({ taskId: 'tid-1' });
    });
  });
});
