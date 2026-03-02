import { describe, expect, it } from 'vitest';

import {
  CHIP_MARKER,
  chipDisplayLabel,
  chipToMarkdown,
  chipToken,
  serializeChipsWithText,
} from '@renderer/types/inlineChip';

import type { InlineChip } from '@renderer/types/inlineChip';

function makeChip(overrides: Partial<InlineChip> = {}): InlineChip {
  return {
    id: 'chip-1',
    filePath: '/src/auth.ts',
    fileName: 'auth.ts',
    fromLine: 10,
    toLine: 15,
    codeText: 'const x = 1;\nconst y = 2;',
    language: 'typescript',
    ...overrides,
  };
}

describe('chipDisplayLabel', () => {
  it('returns fileName:fromLine-toLine for multi-line', () => {
    const chip = makeChip({ fromLine: 10, toLine: 15 });
    expect(chipDisplayLabel(chip)).toBe('auth.ts:10-15');
  });

  it('returns fileName:line for single-line', () => {
    const chip = makeChip({ fromLine: 42, toLine: 42 });
    expect(chipDisplayLabel(chip)).toBe('auth.ts:42');
  });

  it('works with different file names', () => {
    const chip = makeChip({ fileName: 'index.tsx', fromLine: 1, toLine: 3 });
    expect(chipDisplayLabel(chip)).toBe('index.tsx:1-3');
  });

  it('returns just fileName for file-level mention (null lines)', () => {
    const chip = makeChip({ fromLine: null, toLine: null, codeText: '' });
    expect(chipDisplayLabel(chip)).toBe('auth.ts');
  });
});

describe('chipToken', () => {
  it('prepends CHIP_MARKER to display label', () => {
    const chip = makeChip({ fromLine: 10, toLine: 15 });
    expect(chipToken(chip)).toBe(`${CHIP_MARKER}auth.ts:10-15`);
  });

  it('uses single-line format when fromLine === toLine', () => {
    const chip = makeChip({ fromLine: 42, toLine: 42 });
    expect(chipToken(chip)).toBe(`${CHIP_MARKER}auth.ts:42`);
  });

  it('omits line range for file-level mention', () => {
    const chip = makeChip({ fromLine: null, toLine: null, codeText: '' });
    expect(chipToken(chip)).toBe(`${CHIP_MARKER}auth.ts`);
  });
});

describe('chipToMarkdown', () => {
  it('produces markdown code fence for multi-line', () => {
    const chip = makeChip({
      fromLine: 10,
      toLine: 15,
      codeText: 'const x = 1;',
      language: 'typescript',
    });
    const md = chipToMarkdown(chip);
    expect(md).toContain('**auth.ts**');
    expect(md).toContain('lines 10-15');
    expect(md).toContain('```typescript');
    expect(md).toContain('const x = 1;');
    expect(md).toContain('```');
  });

  it('produces markdown code fence for single-line', () => {
    const chip = makeChip({
      fromLine: 42,
      toLine: 42,
      codeText: 'return true;',
    });
    const md = chipToMarkdown(chip);
    expect(md).toContain('line 42');
    expect(md).not.toContain('lines');
  });

  it('uses language from chip', () => {
    const chip = makeChip({ language: 'python', fileName: 'script.py' });
    expect(chipToMarkdown(chip)).toContain('```python');
  });

  it('produces file reference for file-level mention', () => {
    const chip = makeChip({
      fromLine: null,
      toLine: null,
      codeText: '',
      displayPath: 'src/auth.ts',
    });
    const md = chipToMarkdown(chip);
    expect(md).toBe('**auth.ts** (`src/auth.ts`)');
    expect(md).not.toContain('```');
  });

  it('falls back to filePath when displayPath is missing', () => {
    const chip = makeChip({ fromLine: null, toLine: null, codeText: '' });
    const md = chipToMarkdown(chip);
    expect(md).toBe('**auth.ts** (`/src/auth.ts`)');
  });
});

describe('serializeChipsWithText', () => {
  it('returns text unchanged when no chips', () => {
    expect(serializeChipsWithText('hello world', [])).toBe('hello world');
  });

  it('replaces chip token with markdown', () => {
    const chip = makeChip();
    const token = chipToken(chip);
    const text = `Hello\n${token}\nGoodbye`;
    const result = serializeChipsWithText(text, [chip]);
    expect(result).toContain('**auth.ts**');
    expect(result).toContain('```typescript');
    expect(result).not.toContain(CHIP_MARKER);
    expect(result).toContain('Hello');
    expect(result).toContain('Goodbye');
  });

  it('handles multiple chips', () => {
    const chip1 = makeChip({ id: 'c1', fileName: 'a.ts', fromLine: 1, toLine: 3 });
    const chip2 = makeChip({ id: 'c2', fileName: 'b.ts', fromLine: 10, toLine: 20 });
    const text = `${chipToken(chip1)}\n${chipToken(chip2)}`;
    const result = serializeChipsWithText(text, [chip1, chip2]);
    expect(result).toContain('**a.ts**');
    expect(result).toContain('**b.ts**');
    expect(result).not.toContain(CHIP_MARKER);
  });

  it('preserves text around chips', () => {
    const chip = makeChip();
    const text = `Before ${chipToken(chip)} after`;
    const result = serializeChipsWithText(text, [chip]);
    expect(result).toContain('Before ');
    expect(result).toContain(' after');
  });

  it('serializes file-mention chip as file reference', () => {
    const chip = makeChip({
      fromLine: null,
      toLine: null,
      codeText: '',
      displayPath: 'src/auth.ts',
    });
    const text = `Check ${chipToken(chip)} please`;
    const result = serializeChipsWithText(text, [chip]);
    expect(result).toBe('Check **auth.ts** (`src/auth.ts`) please');
    expect(result).not.toContain(CHIP_MARKER);
  });
});
