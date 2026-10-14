import {
  buildTaskLinkHref,
  createEncodedTaskReference,
  linkifyTaskIdsInMarkdown,
  parseTaskLinkHref,
  resolveTaskReferenceCandidate,
} from '@renderer/utils/taskReferenceUtils';
import { describe, expect, it } from 'vitest';

import type { TaskRef } from '@shared/types';

describe('taskReferenceUtils', () => {
  it('never resolves a canonical ID through another task display ID', () => {
    const tasks = [
      { id: 'other', displayId: '1' },
      { id: '1', displayId: '2' },
    ];
    expect(resolveTaskReferenceCandidate(tasks, '1', 'canonical')?.id).toBe('1');
    expect(resolveTaskReferenceCandidate(tasks, '1', 'display')?.id).toBe('other');
    expect(resolveTaskReferenceCandidate(tasks, '2', 'canonical')).toBeUndefined();
  });
  it('consumes the stored reference paired with encoded metadata before a legacy duplicate', () => {
    const first = { taskId: 'canonical-a', teamName: 'team-a', displayId: '1' };
    const second = { taskId: 'canonical-b', teamName: 'team-b', displayId: '1' };
    const text = `${createEncodedTaskReference('1', first.taskId, first.teamName)} then #1`;
    expect(linkifyTaskIdsInMarkdown(text, [first, second])).toBe(
      '[#1](task://canonical-a?team=team-a&display=1) then [#1](task://canonical-b?team=team-b&display=1)'
    );
  });

  it('keeps paired cross-team targets in legacy Markdown links without rewriting explicit links', () => {
    const target = { taskId: 'canonical-b', teamName: 'team-b', displayId: '1' };
    expect(linkifyTaskIdsInMarkdown('[#1](task://1)', [target])).toBe(
      '[#1](task://canonical-b?team=team-b&display=1)'
    );
    expect(
      linkifyTaskIdsInMarkdown('[#1](task://canonical-a?team=team-a&display=1)', [target])
    ).toBe('[#1](task://canonical-a?team=team-a&display=1)');
    expect(linkifyTaskIdsInMarkdown('[#1](https://example.test/task/1)', [target])).toBe(
      '[#1](https://example.test/task/1)'
    );
  });

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
      expect(r).toBe('done [#aa5d608e](task://task-1?team=my-team&display=aa5d608e)');
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
    it('roundtrips literal percent, plus, and escape-like identity text exactly once', () => {
      const ref: TaskRef = {
        taskId: 'canonical%25+escape',
        displayId: 'display%25+100%',
        teamName: 'team%25+literal',
      };

      expect(buildTaskLinkHref(ref)).toBe(
        'task://canonical%2525%2Bescape?team=team%2525%2Bliteral&display=display%2525%2B100%25'
      );
      expect(parseTaskLinkHref(buildTaskLinkHref(ref))).toEqual({
        taskId: 'canonical%25+escape',
        teamName: 'team%25+literal',
        displayId: 'display%25+100%',
      });
    });

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
