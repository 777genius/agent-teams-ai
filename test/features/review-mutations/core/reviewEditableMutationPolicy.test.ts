import {
  parseDeleteEditedFileInput,
  parseSaveEditedFileInput,
} from '@features/review-mutations/main';
import { describe, expect, it } from 'vitest';

describe('review editable mutation policy', () => {
  it('accepts exact save inputs, including a missing-file compare-and-set', () => {
    expect(parseSaveEditedFileInput('/review-root/file.ts', 'after\n', 'before\n')).toEqual({
      filePath: '/review-root/file.ts',
      content: 'after\n',
      expectedCurrentContent: 'before\n',
    });
    expect(parseSaveEditedFileInput('/review-root/new.ts', 'created\n', null)).toEqual({
      filePath: '/review-root/new.ts',
      content: 'created\n',
      expectedCurrentContent: null,
    });
  });

  it.each([
    [42, 'after\n', 'before\n'],
    ['/review-root/file.ts', null, 'before\n'],
    ['/review-root/file.ts', 'after\n', undefined],
    ['/review-root/file.ts', 'after\n', false],
  ])('rejects an invalid save input without coercion', (filePath, content, expected) => {
    expect(parseSaveEditedFileInput(filePath, content, expected)).toBeNull();
  });

  it('accepts exact delete inputs', () => {
    expect(parseDeleteEditedFileInput('/review-root/file.ts', 'before\n')).toEqual({
      filePath: '/review-root/file.ts',
      expectedCurrentContent: 'before\n',
    });
  });

  it('rejects a non-string delete path before authorization', () => {
    expect(parseDeleteEditedFileInput({ renderer: 'value' }, 'before\n')).toBeNull();
  });

  it.each([null, undefined, false, 42])(
    'rejects a non-string delete compare-and-set value',
    (expected) => {
      expect(parseDeleteEditedFileInput('/review-root/file.ts', expected)).toBeNull();
    }
  );
});
