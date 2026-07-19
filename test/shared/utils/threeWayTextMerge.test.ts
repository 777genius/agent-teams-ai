import { describe, expect, it } from 'vitest';

import { threeWayTextMerge } from '../../../src/shared/utils/threeWayTextMerge';

describe('threeWayTextMerge', () => {
  it('restores a rejected chunk without dropping an independent external edit', () => {
    const rejectedBaseline = ['header', 'original', 'one', 'two', 'three', 'tail'].join('\n');
    const appliedWithExternalEdit = [
      'header',
      'original',
      'one',
      'two',
      'three',
      'tail-external',
    ].join('\n');
    const contentBeforeReject = ['header', 'agent-change', 'one', 'two', 'three', 'tail'].join(
      '\n'
    );

    const result = threeWayTextMerge(
      rejectedBaseline,
      appliedWithExternalEdit,
      contentBeforeReject
    );

    expect(result.hasConflicts).toBe(false);
    expect(result.content).toBe(
      ['header', 'agent-change', 'one', 'two', 'three', 'tail-external'].join('\n')
    );
  });

  it('reports overlapping edits instead of silently choosing one side', () => {
    const result = threeWayTextMerge('base', 'external', 'agent');

    expect(result.hasConflicts).toBe(true);
  });

  it('preserves CRLF and trailing blank lines from the current file', () => {
    const base = 'header\r\nagent\r\none\r\ntwo\r\nthree\r\ntail\r\n\r\n';
    const ours = 'header\r\nagent\r\none\r\ntwo\r\nthree\r\nexternal\r\n\r\n';
    const theirs = 'header\r\noriginal\r\none\r\ntwo\r\nthree\r\ntail\r\n\r\n';

    const result = threeWayTextMerge(base, ours, theirs);

    expect(result).toEqual({
      content: 'header\r\noriginal\r\none\r\ntwo\r\nthree\r\nexternal\r\n\r\n',
      hasConflicts: false,
    });
    expect(result.content).not.toMatch(/(^|[^\r])\n/);
  });

  it('preserves CRLF in conflict output', () => {
    const result = threeWayTextMerge('base\r\n\r\n', 'ours\r\n\r\n', 'theirs\r\n\r\n');

    expect(result.hasConflicts).toBe(true);
    expect(result.content).toContain('<<<<<<< current\r\n');
    expect(result.content.endsWith('\r\n\r\n')).toBe(true);
    expect(result.content).not.toMatch(/(^|[^\r])\n/);
  });

  it('falls back to baseline CRLF when the current side has no newline', () => {
    const result = threeWayTextMerge('one\r\ntwo', 'current', 'one\r\nagent');

    expect(result.hasConflicts).toBe(true);
    expect(result.content).toContain('<<<<<<< current\r\n');
    expect(result.content).not.toMatch(/(^|[^\r])\n/);
  });
});
