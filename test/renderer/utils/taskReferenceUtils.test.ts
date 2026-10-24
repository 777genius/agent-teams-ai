import {
  buildTaskLinkHref,
  createEncodedTaskReference,
  linkifyTaskIdsInMarkdown,
  navigateTaskReference,
  parseTaskLinkHref,
  resolveTaskReferenceCandidate,
} from '@renderer/utils/taskReferenceUtils';
import { describe, expect, it, vi } from 'vitest';

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

  it('pairs descriptive Markdown labels in occurrence order across external and cross-team links', () => {
    const refs = [
      { taskId: 'canonical-a', teamName: 'team-a', displayId: '1' },
      { taskId: 'canonical-b', teamName: 'team-b', displayId: '1' },
      { taskId: 'canonical-c', teamName: 'team-c', displayId: '1' },
    ];
    expect(
      linkifyTaskIdsInMarkdown('[source #1](https://example.test) [Task #1](task://1) #1', refs)
    ).toBe(
      '[source #1](https://example.test) [Task #1](task://canonical-b?team=team-b&display=1) [#1](task://canonical-c?team=team-c&display=1)'
    );
    expect(linkifyTaskIdsInMarkdown('[ #1 ](task://1)', [refs[1]])).toBe(
      '[ #1 ](task://canonical-b?team=team-b&display=1)'
    );
  });

  it('keeps duplicate, encoded, escaped, fenced, and explicit label references paired correctly', () => {
    const first = { taskId: 'canonical-a', teamName: 'team-a', displayId: '1' };
    const second = { taskId: 'canonical-b', teamName: 'team-b', displayId: '1' };
    const third = { taskId: 'canonical-c', teamName: 'team-c', displayId: '1' };
    const encoded = createEncodedTaskReference('1', first.taskId, first.teamName);

    expect(linkifyTaskIdsInMarkdown('[#1 #1](task://1) #1', [first, second, third])).toBe(
      '[#1 #1](task://canonical-a?team=team-a&display=1) [#1](task://canonical-c?team=team-c&display=1)'
    );
    expect(linkifyTaskIdsInMarkdown(`[${encoded}](https://example.test) #1`, [first, second])).toBe(
      `[${encoded}](https://example.test) [#1](task://canonical-b?team=team-b&display=1)`
    );
    expect(linkifyTaskIdsInMarkdown('[\\#1](https://example.test) #1', [first])).toBe(
      '[\\#1](https://example.test) [#1](task://canonical-a?team=team-a&display=1)'
    );
    expect(linkifyTaskIdsInMarkdown('```\n[#1](task://1)\n```\n[#1](task://1)', [first])).toBe(
      '```\n[#1](task://1)\n```\n[#1](task://canonical-a?team=team-a&display=1)'
    );
    expect(
      linkifyTaskIdsInMarkdown('[Task #1](task://canonical-a?team=team-a&display=1)', [first])
    ).toBe('[Task #1](task://canonical-a?team=team-a&display=1)');
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
      const href = 'task://tid-1?team=team-a&display=T-1';
      expect(buildTaskLinkHref(ref)).toBe(href);

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
  describe('owner-qualified TaskRef navigation', () => {
    const selection = 'host-team:TEST-imported-owner';
    it.each([undefined, selection])(
      'keeps an internal reference on its destination (%s)',
      (teamName) => {
        const local = vi.fn(),
          global = vi.fn();
        const parsed = parseTaskLinkHref(
          teamName
            ? buildTaskLinkHref({ taskId: 'internal', displayId: '18', teamName })
            : 'task://internal'
        )!;
        navigateTaskReference(parsed, selection, local, global);
        expect(local).toHaveBeenCalledExactlyOnceWith('internal');
        expect(global).not.toHaveBeenCalled();
      }
    );
    it.each([
      'other-owner',
      `${selection}:source-archive:legacy-archive%3ATEST`,
      `${selection}:source-gap:legacy-gap%3ATEST`,
    ])('preserves the explicit owner %s without local scrolling', (teamName) => {
      const local = vi.fn(),
        global = vi.fn();
      const parsed = parseTaskLinkHref(
        buildTaskLinkHref({
          taskId: 'same-id',
          displayId: '99',
          teamName,
        })
      )!;
      navigateTaskReference(parsed, selection, local, global);
      expect(global).toHaveBeenCalledExactlyOnceWith(teamName, 'same-id');
      expect(local).not.toHaveBeenCalled();
    });
  });
});
