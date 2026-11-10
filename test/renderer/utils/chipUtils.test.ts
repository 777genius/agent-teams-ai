import { describe, expect, it } from 'vitest';

import { chipToken } from '@renderer/types/inlineChip';
import {
  calculateMentionPositions,
  createChipFromSelection,
  findChipBoundary,
  isInsideChip,
  reconcileChips,
  removeChipTokenFromText,
  snapCursorToChipBoundary,
} from '@renderer/utils/chipUtils';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { EditorSelectionAction } from '@shared/types/editor';

function makeChip(overrides: Partial<InlineChip> = {}): InlineChip {
  return {
    id: 'chip-test-1',
    filePath: '/src/auth.ts',
    fileName: 'auth.ts',
    fromLine: 10,
    toLine: 15,
    codeText: 'const x = 1;',
    language: 'typescript',
    ...overrides,
  };
}

function makeAction(overrides: Partial<EditorSelectionAction> = {}): EditorSelectionAction {
  return {
    type: 'sendMessage',
    filePath: '/src/auth.ts',
    fromLine: 10,
    toLine: 15,
    selectedText: 'const x = 1;',
    formattedContext: '**auth.ts** (lines 10-15):\n```typescript\nconst x = 1;\n```',
    ...overrides,
  };
}

describe('createChipFromSelection', () => {
  it('creates a chip from an EditorSelectionAction', () => {
    const action = makeAction();
    const chip = createChipFromSelection(action, []);
    expect(chip).not.toBeNull();
    expect(chip!.filePath).toBe('/src/auth.ts');
    expect(chip!.fileName).toBe('auth.ts');
    expect(chip!.fromLine).toBe(10);
    expect(chip!.toLine).toBe(15);
    expect(chip!.codeText).toBe('const x = 1;');
    expect(chip!.language).toBe('typescript');
    expect(chip!.id).toMatch(/^chip-/);
  });

  it('returns null for duplicate (same filePath + lines)', () => {
    const existing = makeChip();
    const action = makeAction();
    expect(createChipFromSelection(action, [existing])).toBeNull();
  });

  it('allows different line ranges for the same file', () => {
    const existing = makeChip({ fromLine: 1, toLine: 5 });
    const action = makeAction({ fromLine: 10, toLine: 15 });
    expect(createChipFromSelection(action, [existing])).not.toBeNull();
  });

  it('creates a file-mention chip when selectedText is empty and lines are null', () => {
    const action = makeAction({
      selectedText: '',
      fromLine: null,
      toLine: null,
      displayPath: 'src/auth.ts',
    });
    const chip = createChipFromSelection(action, []);
    expect(chip).not.toBeNull();
    expect(chip!.fromLine).toBeNull();
    expect(chip!.toLine).toBeNull();
    expect(chip!.codeText).toBe('');
    expect(chip!.displayPath).toBe('src/auth.ts');
    expect(chip!.fileName).toBe('auth.ts');
  });

  it('deduplicates file-mention chips by filePath', () => {
    const existing = makeChip({ fromLine: null, toLine: null, codeText: '' });
    const action = makeAction({ selectedText: '', fromLine: null, toLine: null });
    expect(createChipFromSelection(action, [existing])).toBeNull();
  });

  it('creates file-mention chip when fromLine is null', () => {
    const action = makeAction({ fromLine: null, selectedText: 'code' });
    const chip = createChipFromSelection(action, []);
    expect(chip).not.toBeNull();
    expect(chip!.fromLine).toBeNull();
  });
});

describe('findChipBoundary', () => {
  it('returns boundary when cursor is at chip end', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `Hello ${token} world`;
    const cursorPos = 6 + token.length; // at end of token
    const boundary = findChipBoundary(text, [chip], cursorPos);
    expect(boundary).not.toBeNull();
    expect(boundary!.start).toBe(6);
    expect(boundary!.end).toBe(6 + token.length);
    expect(boundary!.chip).toBe(chip);
  });

  it('returns boundary when cursor is at chip start', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `Hello ${token} world`;
    const boundary = findChipBoundary(text, [chip], 6);
    expect(boundary).not.toBeNull();
    expect(boundary!.start).toBe(6);
  });

  it('returns boundary when cursor is inside chip', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `Hello ${token} world`;
    const boundary = findChipBoundary(text, [chip], 8);
    expect(boundary).not.toBeNull();
  });

  it('returns null when cursor is not near any chip', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `Hello ${token} world`;
    // cursor at beginning
    expect(findChipBoundary(text, [chip], 0)).toBeNull();
  });

  it('handles multiple chips', () => {
    const chip1 = makeChip({ id: 'c1', fileName: 'a.ts', fromLine: 1, toLine: 1 });
    const chip2 = makeChip({ id: 'c2', fileName: 'b.ts', fromLine: 2, toLine: 2 });
    const t1 = chipToken(chip1);
    const t2 = chipToken(chip2);
    const text = `${t1} ${t2}`;
    const boundary = findChipBoundary(text, [chip1, chip2], t1.length + 1);
    expect(boundary).not.toBeNull();
    expect(boundary!.chip.id).toBe('c2');
  });
});

describe('isInsideChip', () => {
  it('returns true when cursor is strictly inside', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `X${token}Y`;
    expect(isInsideChip(text, [chip], 3)).toBe(true);
  });

  it('returns false at chip start boundary', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `X${token}Y`;
    expect(isInsideChip(text, [chip], 1)).toBe(false);
  });

  it('returns false at chip end boundary', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `X${token}Y`;
    expect(isInsideChip(text, [chip], 1 + token.length)).toBe(false);
  });

  it('returns false outside chip', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `X${token}Y`;
    expect(isInsideChip(text, [chip], 0)).toBe(false);
  });
});

describe('snapCursorToChipBoundary', () => {
  it('snaps to nearest start when cursor is closer to start', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `X${token}Y`;
    // position 2 is inside, closer to start (1)
    const snapped = snapCursorToChipBoundary(text, [chip], 2);
    expect(snapped).toBe(1);
  });

  it('snaps to nearest end when cursor is closer to end', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `X${token}Y`;
    // position close to end
    const nearEnd = 1 + token.length - 1;
    const snapped = snapCursorToChipBoundary(text, [chip], nearEnd);
    expect(snapped).toBe(1 + token.length);
  });

  it('returns original position if not inside chip', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `X${token}Y`;
    expect(snapCursorToChipBoundary(text, [chip], 0)).toBe(0);
  });
});

describe('reconcileChips', () => {
  it('keeps chips whose tokens are present', () => {
    const chip = makeChip();
    const text = `Hello ${chipToken(chip)} world`;
    expect(reconcileChips([chip], text)).toEqual([chip]);
  });

  it('removes chips whose tokens are missing', () => {
    const chip = makeChip();
    expect(reconcileChips([chip], 'Hello world')).toEqual([]);
  });

  it('handles partial removal (only some chips gone)', () => {
    const chip1 = makeChip({ id: 'c1', fileName: 'a.ts', fromLine: 1, toLine: 1 });
    const chip2 = makeChip({ id: 'c2', fileName: 'b.ts', fromLine: 2, toLine: 2 });
    const text = chipToken(chip1); // only chip1 token present
    const result = reconcileChips([chip1, chip2], text);
    expect(result).toEqual([chip1]);
  });
});

describe('removeChipTokenFromText', () => {
  it('removes the token from text', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `Hello ${token} world`;
    expect(removeChipTokenFromText(text, chip)).toBe('Hello  world');
  });

  it('removes trailing newline', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `${token}\nHello`;
    expect(removeChipTokenFromText(text, chip)).toBe('Hello');
  });

  it('does not alter text when token not found', () => {
    const chip = makeChip();
    const text = 'Hello world';
    expect(removeChipTokenFromText(text, chip)).toBe('Hello world');
  });

  it('removes token from middle of text', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `A\n${token}\nB`;
    expect(removeChipTokenFromText(text, chip)).toBe('A\nB');
  });
});

describe('calculateMentionPositions boundary regex', () => {
  function makeTextarea(): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    ta.style.cssText = 'font:16px monospace;width:400px;height:100px';
    document.body.appendChild(ta);
    return ta;
  }

  function makeMemberSuggestion(name: string) {
    return { id: name, name, type: 'member' as const };
  }

  it('matches @mention when char after is boundary: space, comma, dot', () => {
    const ta = makeTextarea();
    const suggestions = [makeMemberSuggestion('Alice')];
    expect(calculateMentionPositions(ta, '@Alice ', suggestions)).toHaveLength(1);
    expect(calculateMentionPositions(ta, '@Alice,', suggestions)).toHaveLength(1);
    expect(calculateMentionPositions(ta, '@Alice.', suggestions)).toHaveLength(1);
    document.body.removeChild(ta);
  });

  it('matches @mention when char after is boundary: colon, semicolon, bang, question', () => {
    const ta = makeTextarea();
    const suggestions = [makeMemberSuggestion('Alice')];
    expect(calculateMentionPositions(ta, '@Alice:', suggestions)).toHaveLength(1);
    expect(calculateMentionPositions(ta, '@Alice;', suggestions)).toHaveLength(1);
    expect(calculateMentionPositions(ta, '@Alice!', suggestions)).toHaveLength(1);
    expect(calculateMentionPositions(ta, '@Alice?', suggestions)).toHaveLength(1);
    document.body.removeChild(ta);
  });

  it('matches @mention when char after is boundary: ), ], }, -', () => {
    const ta = makeTextarea();
    const suggestions = [makeMemberSuggestion('Alice')];
    expect(calculateMentionPositions(ta, '@Alice)', suggestions)).toHaveLength(1);
    expect(calculateMentionPositions(ta, '@Alice]', suggestions)).toHaveLength(1);
    expect(calculateMentionPositions(ta, '@Alice}', suggestions)).toHaveLength(1);
    expect(calculateMentionPositions(ta, '@Alice-', suggestions)).toHaveLength(1);
    document.body.removeChild(ta);
  });

  it('does NOT match @mention when char after is word char (letter, digit)', () => {
    const ta = makeTextarea();
    const suggestions = [makeMemberSuggestion('Alice')];
    expect(calculateMentionPositions(ta, '@Alicex', suggestions)).toHaveLength(0);
    expect(calculateMentionPositions(ta, '@Alice1', suggestions)).toHaveLength(0);
    expect(calculateMentionPositions(ta, '@Alice_', suggestions)).toHaveLength(0);
    document.body.removeChild(ta);
  });
});
