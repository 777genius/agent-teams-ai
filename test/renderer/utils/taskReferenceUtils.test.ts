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

    it('linkifies standalone task refs wrapped in inline code', () => {
      const taskRef: TaskRef = {
        taskId: 'task-1',
        displayId: 'aa5d608e',
        teamName: 'my-team',
      };
      const r = linkifyTaskIdsInMarkdown('done `#aa5d608e`', [taskRef]);
      expect(r).toBe(
        'done [#aa5d608e](task://task-1?team=my-team&display=aa5d608e)'
      );
    });

    it('does not linkify non-task inline code', () => {
      const r = linkifyTaskIdsInMarkdown('avoid `eval` and `x#task1`');
      expect(r).toBe('avoid `eval` and `x#task1`');
    });

    it('does not rewrite existing markdown links', () => {
      const existing = '[#aa5d608e](task://aa5d608e)';
      const r = linkifyTaskIdsInMarkdown(existing);
      expect(r).toBe(existing);
    });

    it('does not linkify task-looking text in fenced code blocks', () => {
      const r = linkifyTaskIdsInMarkdown('```\n#aa5d608e\n```\n#bb7c9012');
      expect(r).toBe('```\n#aa5d608e\n```\n[#bb7c9012](task://bb7c9012)');
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
