import { describe, expect, it } from 'vitest';

import {
  getReviewKeyForFilePath,
  normalizePersistedReviewState,
} from '../../../src/renderer/utils/reviewKey';

describe('reviewKey path normalization', () => {
  it('maps slash variants of Windows file paths to the same review key', () => {
    const files = [{ filePath: 'C:\\Repo\\src\\file.ts', changeKey: 'path:c:/repo/src/file.ts' }];

    expect(getReviewKeyForFilePath(files, 'C:/Repo/src/file.ts')).toBe('path:c:/repo/src/file.ts');
  });

  it('maps relative Windows slash variants to the same review key', () => {
    const files = [{ filePath: 'SRC\\File.ts', changeKey: 'path:SRC/File.ts' }];

    expect(getReviewKeyForFilePath(files, 'SRC/File.ts')).toBe('path:SRC/File.ts');
    expect(getReviewKeyForFilePath(files, 'src/file.ts')).toBe('src/file.ts');
  });

  it('keeps case-distinct Windows files separate and refuses ambiguous folded aliases', () => {
    const files = [
      { filePath: 'C:\\Sensitive\\Foo.ts', changeKey: 'path:C:/Sensitive/Foo.ts' },
      { filePath: 'C:\\Sensitive\\foo.ts', changeKey: 'path:C:/Sensitive/foo.ts' },
    ];

    expect(getReviewKeyForFilePath(files, 'C:/Sensitive/Foo.ts')).toBe(files[0].changeKey);
    expect(getReviewKeyForFilePath(files, 'C:/Sensitive/foo.ts')).toBe(files[1].changeKey);
    expect(getReviewKeyForFilePath(files, 'c:/sensitive/FOO.ts')).toBe('c:/sensitive/FOO.ts');
  });

  it('hydrates distinct persisted Windows decisions without merging their keys', () => {
    const files = [
      { filePath: 'C:\\Sensitive\\Foo.ts', changeKey: 'path:C:/Sensitive/Foo.ts' },
      { filePath: 'C:\\Sensitive\\foo.ts', changeKey: 'path:C:/Sensitive/foo.ts' },
    ];
    const state = normalizePersistedReviewState(files, {
      fileDecisions: {
        'C:/Sensitive/Foo.ts': 'accepted',
        'C:/Sensitive/foo.ts': 'rejected',
        'c:/sensitive/FOO.ts': 'accepted',
      },
      hunkDecisions: {
        'C:/Sensitive/Foo.ts:0': 'accepted',
        'C:/Sensitive/foo.ts:0': 'rejected',
      },
    });

    expect(state.fileDecisions).toEqual({
      [files[0].changeKey]: 'accepted',
      [files[1].changeKey]: 'rejected',
    });
    expect(state.hunkDecisions).toEqual({
      [`${files[0].changeKey}:0`]: 'accepted',
      [`${files[1].changeKey}:0`]: 'rejected',
    });
  });

  it('normalizes persisted legacy Windows path decisions onto changeKey entries', () => {
    const files = [{ filePath: 'C:/Repo/src/file.ts', changeKey: 'path:c:/repo/src/file.ts' }];
    const state = normalizePersistedReviewState(files, {
      fileDecisions: { 'c:\\repo\\src\\file.ts': 'rejected' },
      hunkDecisions: { 'c:\\repo\\src\\file.ts:2': 'accepted' },
      hunkContextHashesByFile: { 'c:\\repo\\src\\file.ts': { 2: 'ctx' } },
    });

    expect(state.fileDecisions).toEqual({ 'path:c:/repo/src/file.ts': 'rejected' });
    expect(state.hunkDecisions).toEqual({ 'path:c:/repo/src/file.ts:2': 'accepted' });
    expect(state.hunkContextHashesByFile).toEqual({
      'path:c:/repo/src/file.ts': { 2: 'ctx' },
    });
  });

  it('normalizes persisted Windows worktree relation decisions onto changeKey entries', () => {
    const changeKey = 'rename:C:/Repo/.claude/worktrees/team-a:src/old.ts->src/new.ts';
    const files = [{ filePath: 'C:\\Repo\\.claude\\worktrees\\team-a\\src\\new.ts', changeKey }];
    const state = normalizePersistedReviewState(files, {
      fileDecisions: {
        'rename:c:\\repo\\.claude\\worktrees\\team-a:src\\old.ts->src\\new.ts': 'rejected',
      },
      hunkDecisions: {
        'rename:c:\\repo\\.claude\\worktrees\\team-a:src\\old.ts->src\\new.ts:1': 'accepted',
      },
      hunkContextHashesByFile: {
        'rename:c:\\repo\\.claude\\worktrees\\team-a:src\\old.ts->src\\new.ts': { 1: 'ctx' },
      },
    });

    expect(state.fileDecisions).toEqual({ [changeKey]: 'rejected' });
    expect(state.hunkDecisions).toEqual({ [`${changeKey}:1`]: 'accepted' });
    expect(state.hunkContextHashesByFile).toEqual({ [changeKey]: { 1: 'ctx' } });
  });

  it('normalizes persisted relative Windows relation decisions onto case-preserving changeKey entries', () => {
    const changeKey = 'rename:src/OLD.ts->src/NEW.ts';
    const files = [{ filePath: 'SRC\\NEW.ts', changeKey }];
    const state = normalizePersistedReviewState(files, {
      fileDecisions: {
        'rename:src\\old.ts->src\\new.ts': 'rejected',
      },
      hunkDecisions: {
        'rename:src\\old.ts->src\\new.ts:1': 'accepted',
      },
      hunkContextHashesByFile: {
        'rename:src\\old.ts->src\\new.ts': { 1: 'ctx' },
      },
    });

    expect(state.fileDecisions).toEqual({ [changeKey]: 'rejected' });
    expect(state.hunkDecisions).toEqual({ [`${changeKey}:1`]: 'accepted' });
    expect(state.hunkContextHashesByFile).toEqual({ [changeKey]: { 1: 'ctx' } });
  });

  it('normalizes persisted relative Windows relation decisions even when stored with slash separators', () => {
    const changeKey = 'rename:src/OLD.ts->src/NEW.ts';
    const files = [{ filePath: 'SRC\\NEW.ts', changeKey }];
    const state = normalizePersistedReviewState(files, {
      fileDecisions: {
        'rename:SRC/OLD.ts->SRC/NEW.ts': 'rejected',
      },
      hunkDecisions: {
        'rename:SRC/OLD.ts->SRC/NEW.ts:1': 'accepted',
      },
      hunkContextHashesByFile: {
        'rename:SRC/OLD.ts->SRC/NEW.ts': { 1: 'ctx' },
      },
    });

    expect(state.fileDecisions).toEqual({ [changeKey]: 'rejected' });
    expect(state.hunkDecisions).toEqual({ [`${changeKey}:1`]: 'accepted' });
    expect(state.hunkContextHashesByFile).toEqual({ [changeKey]: { 1: 'ctx' } });
  });

  it('keeps POSIX-only persisted decisions case-sensitive', () => {
    const files = [{ filePath: 'src/file.ts', changeKey: 'path:src/file.ts' }];
    const state = normalizePersistedReviewState(files, {
      fileDecisions: { 'SRC/File.ts': 'rejected' },
      hunkDecisions: { 'SRC/File.ts:1': 'accepted' },
      hunkContextHashesByFile: { 'SRC/File.ts': { 1: 'ctx' } },
    });

    expect(state.fileDecisions).toEqual({});
    expect(state.hunkDecisions).toEqual({});
    expect(state.hunkContextHashesByFile).toEqual({});
  });
});
