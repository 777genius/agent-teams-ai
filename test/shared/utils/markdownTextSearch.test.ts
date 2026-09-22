import { describe, expect, it } from 'vitest';

import {
  collectTextSegments,
  countMarkdownSearchMatches,
  extractMarkdownPlainText,
  findMarkdownSearchMatches,
} from '../../../src/shared/utils/markdownTextSearch';

describe('markdownTextSearch', () => {
  // ---------------------------------------------------------------------------
  // collectTextSegments (now takes markdown string, uses HAST internally)
  // ---------------------------------------------------------------------------

  describe('collectTextSegments', () => {
    it('extracts plain text from a paragraph', () => {
      const segments = collectTextSegments('Hello world');
      expect(segments).toEqual(['Hello world']);
    });

    it('extracts text from bold/italic nodes', () => {
      const segments = collectTextSegments('Hello **bold** and *italic*');
      expect(segments).toEqual(['Hello ', 'bold', ' and ', 'italic']);
    });

    it('keeps code block content as a single segment with trailing newline', () => {
      // HAST adds trailing \n to code block text — matches what ReactMarkdown
      // passes to its <code> component as children
      const segments = collectTextSegments('```js\nconst x = 1;\nconst y = 2;\n```');
      expect(segments).toEqual(['const x = 1;\nconst y = 2;\n']);
    });

    it('extracts inline code text', () => {
      const segments = collectTextSegments('Use `findMatches` here');
      expect(segments).toEqual(['Use ', 'findMatches', ' here']);
    });

    it('extracts link text but not URL', () => {
      const segments = collectTextSegments('[docs](https://example.com)');
      expect(segments).toEqual(['docs']);
    });

    it('does NOT include image alt text', () => {
      const segments = collectTextSegments('![screenshot](./img.png)');
      expect(segments).toEqual([]);
    });

    it('extracts list item text', () => {
      const segments = collectTextSegments('- item one\n- item two');
      expect(segments).toContain('item one');
      expect(segments).toContain('item two');
    });

    it('extracts heading text', () => {
      const segments = collectTextSegments('## Important Section');
      expect(segments).toContain('Important Section');
    });

    it('extracts table cell text', () => {
      const segments = collectTextSegments(
        '| Header | Value |\n|--------|-------|\n| Cell   | Data  |'
      );
      expect(segments).toContain('Header');
      expect(segments).toContain('Cell');
      expect(segments).toContain('Data');
    });

    it('extracts blockquote text', () => {
      const segments = collectTextSegments('> quoted text');
      expect(segments).toContain('quoted text');
    });

    it('extracts h5 heading text', () => {
      const segments = collectTextSegments('##### Sub-heading');
      expect(segments).toContain('Sub-heading');
    });

    it('extracts h6 heading text', () => {
      const segments = collectTextSegments('###### Tiny heading');
      expect(segments).toContain('Tiny heading');
    });

    it('extracts strikethrough (del) text', () => {
      const segments = collectTextSegments('This is ~~removed~~ text');
      expect(segments).toContain('removed');
    });

    it('collects nested inline text in document order', () => {
      const segments = collectTextSegments('first **bold** last');
      // Segments must be in document order: "first " before "bold" before " last"
      expect(segments).toEqual(['first ', 'bold', ' last']);
    });

    it('does NOT include inter-block whitespace', () => {
      // Whitespace text nodes at root level (between blocks) should NOT be collected
      const segments = collectTextSegments('Paragraph one\n\nParagraph two');
      const newlineOnlySegments = segments.filter((s) => s.trim() === '');
      // Any whitespace segments should only be inside hl elements (like li), not at root level
      expect(segments).toContain('Paragraph one');
      expect(segments).toContain('Paragraph two');
      // Root-level "\n" nodes should be excluded
      expect(newlineOnlySegments.length).toBeLessThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // findMarkdownSearchMatches
  // ---------------------------------------------------------------------------

  describe('findMarkdownSearchMatches', () => {
    it('finds matches in plain text', () => {
      const matches = findMarkdownSearchMatches('hello world hello', 'hello');
      expect(matches).toHaveLength(2);
      expect(matches[0].matchIndexInItem).toBe(0);
      expect(matches[1].matchIndexInItem).toBe(1);
    });

    it('is case-insensitive', () => {
      const matches = findMarkdownSearchMatches('Hello HELLO', 'hello');
      expect(matches).toHaveLength(2);
    });

    it('finds matches in bold text (strips ** markers)', () => {
      const matches = findMarkdownSearchMatches('This is **important** text', 'important');
      expect(matches).toHaveLength(1);
    });

    it('does NOT match markdown syntax characters like **', () => {
      const matches = findMarkdownSearchMatches('This is **bold** text', '**');
      expect(matches).toHaveLength(0);
    });

    it('does NOT match code fence language identifiers', () => {
      const md = '```tsx\nconst x = 1;\n```';
      const matches = findMarkdownSearchMatches(md, 'tsx');
      expect(matches).toHaveLength(0);
    });

    it('finds matches inside fenced code block content', () => {
      const md = '```ts\nconst tsx = "value";\n```';
      const matches = findMarkdownSearchMatches(md, 'tsx');
      expect(matches).toHaveLength(1);
    });

    it('finds matches in inline code', () => {
      const matches = findMarkdownSearchMatches('Use `findMatches` here', 'findmatches');
      expect(matches).toHaveLength(1);
    });

    it('does NOT match link URLs', () => {
      const md = 'Check [docs](https://example.com/docs) here';
      const matches = findMarkdownSearchMatches(md, 'example.com');
      expect(matches).toHaveLength(0);
    });

    it('matches link text but not URL', () => {
      const md = 'Check [the docs](https://example.com) here';
      const matches = findMarkdownSearchMatches(md, 'the docs');
      expect(matches).toHaveLength(1);
    });

    it('does NOT match image alt text', () => {
      const md = 'An image: ![screenshot](./img.png)';
      const matches = findMarkdownSearchMatches(md, 'screenshot');
      expect(matches).toHaveLength(0);
    });

    it('does NOT match heading markers (#)', () => {
      const md = '# Title\n\nSome text';
      const matches = findMarkdownSearchMatches(md, '#');
      expect(matches).toHaveLength(0);
    });

    it('finds matches in heading text', () => {
      const md = '## Important Section\n\nBody text';
      const matches = findMarkdownSearchMatches(md, 'important');
      expect(matches).toHaveLength(1);
    });

    it('does NOT match list markers', () => {
      const md = '- item one\n- item two';
      const matches = findMarkdownSearchMatches(md, '-');
      expect(matches).toHaveLength(0);
    });

    it('does NOT match across text segments (no cross-node matches)', () => {
      // "**th**eory" renders as two text nodes: "th" and "eory"
      // A search for "theory" should NOT match because it spans nodes
      const md = '**th**eory';
      const matches = findMarkdownSearchMatches(md, 'theory');
      expect(matches).toHaveLength(0);
    });

    it('handles strikethrough text', () => {
      const md = 'This is ~~deleted~~ text';
      const matches = findMarkdownSearchMatches(md, 'deleted');
      expect(matches).toHaveLength(1);
      const tildeMatches = findMarkdownSearchMatches(md, '~~');
      expect(tildeMatches).toHaveLength(0);
    });

    it('handles tables', () => {
      const md = '| Header | Value |\n|--------|-------|\n| Cell   | Data  |';
      const matches = findMarkdownSearchMatches(md, 'cell');
      expect(matches).toHaveLength(1);
    });

    it('returns empty for empty input', () => {
      expect(findMarkdownSearchMatches('', 'test')).toEqual([]);
      expect(findMarkdownSearchMatches('test', '')).toEqual([]);
    });

    it('handles blockquotes', () => {
      const md = '> quoted text here';
      const matches = findMarkdownSearchMatches(md, 'quoted');
      expect(matches).toHaveLength(1);
    });

    it('finds matches in h5 headings', () => {
      const md = '##### Sub-heading\n\nBody text';
      const matches = findMarkdownSearchMatches(md, 'sub-heading');
      expect(matches).toHaveLength(1);
    });

    it('finds matches in h6 headings', () => {
      const md = '###### Tiny heading\n\nBody text';
      const matches = findMarkdownSearchMatches(md, 'tiny');
      expect(matches).toHaveLength(1);
    });

    it('finds matches in strikethrough (del) text', () => {
      const md = 'This is ~~deleted content~~ here';
      const matches = findMarkdownSearchMatches(md, 'deleted');
      expect(matches).toHaveLength(1);
    });

    it('does not match reference-style link definitions', () => {
      const md = '[link text][ref]\n\n[ref]: https://example.com';
      const matches = findMarkdownSearchMatches(md, 'example.com');
      expect(matches).toHaveLength(0);
    });

    it('treats code block content as single segment (allows cross-line match)', () => {
      // Code block is a single text node in HAST, matching what ReactMarkdown's
      // <code> component receives as children. Cross-line matches ARE valid
      // because highlightSearchText operates on the full string.
      const md = '```js\nconst x = 1;\nconst y = 2;\n```';
      const matches = findMarkdownSearchMatches(md, '1;\nconst');
      expect(matches).toHaveLength(1);
    });

    it('finds per-line matches inside code blocks', () => {
      const md = '```js\nconst x = 1;\nconst y = 2;\n```';
      const matches = findMarkdownSearchMatches(md, 'const');
      expect(matches).toHaveLength(2);
      expect(matches[0].matchIndexInItem).toBe(0);
      expect(matches[1].matchIndexInItem).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // countMarkdownSearchMatches
  // ---------------------------------------------------------------------------

  describe('countMarkdownSearchMatches', () => {
    it('returns correct count', () => {
      const count = countMarkdownSearchMatches('hello **world** hello', 'hello');
      expect(count).toBe(2);
    });

    it('returns 0 for no matches', () => {
      expect(countMarkdownSearchMatches('hello world', 'xyz')).toBe(0);
    });

    it('returns 0 for empty inputs', () => {
      expect(countMarkdownSearchMatches('', 'test')).toBe(0);
      expect(countMarkdownSearchMatches('test', '')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // extractMarkdownPlainText
  // ---------------------------------------------------------------------------

  describe('extractMarkdownPlainText', () => {
    it('extracts plain text from markdown', () => {
      const text = extractMarkdownPlainText('**bold** and `code`');
      expect(text).toContain('bold');
      expect(text).toContain('code');
      expect(text).not.toContain('**');
      expect(text).not.toContain('`');
    });

    it('strips code fence language', () => {
      const text = extractMarkdownPlainText('```tsx\nconst x = 1;\n```');
      expect(text).toContain('const x = 1;');
      expect(text).not.toMatch(/(?:^|\s)tsx(?:\s|$)/);
    });

    it('returns empty string for empty input', () => {
      expect(extractMarkdownPlainText('')).toBe('');
    });
  });
});
