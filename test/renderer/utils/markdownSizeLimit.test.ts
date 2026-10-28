import {
  mapMarkdownOutsideCode,
  normalizeLegacyMarkdownEscapes,
  stripAgentBlocksForMarkdown,
} from '@renderer/utils/markdownCodeRanges';
import { MAX_MARKDOWN_CHARS } from '@renderer/utils/markdownLimits';
import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { unified } from 'unified';
import { describe, expect, it, vi } from 'vitest';

function fencedMessage(length: number): string {
  const start = 'Before\n\n```text\n';
  const end = '\n```\n\nAfter';
  return start + 'x'.repeat(length - start.length - end.length) + end;
}

describe('Markdown preprocessing size limit', () => {
  it('preserves oversized code-bearing messages without parsing or transforming them', () => {
    const parse = vi.spyOn(Object.getPrototypeOf(unified), 'parse');
    const transform = vi.fn((text: string) => text.replace('Before', 'Changed'));
    const source = fencedMessage(MAX_MARKDOWN_CHARS + 1);
    try {
      expect(mapMarkdownOutsideCode(source, transform)).toBe(source);
      expect(parse).not.toHaveBeenCalled();
      expect(transform).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('still transforms prose and preserves code at the inclusive rendering limit', () => {
    const source = fencedMessage(MAX_MARKDOWN_CHARS);
    expect(mapMarkdownOutsideCode(source, (text) => text.replace('Before', 'Changed'))).toBe(
      source.replace('Before', 'Changed')
    );
  });

  it('keeps inexpensive transformations for oversized text without code syntax', () => {
    const parse = vi.spyOn(Object.getPrototypeOf(unified), 'parse');
    const source = 'Before ' + 'x'.repeat(MAX_MARKDOWN_CHARS);
    try {
      expect(mapMarkdownOutsideCode(source, (text) => text.replace('Before', 'Changed'))).toBe(
        source.replace('Before', 'Changed')
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('still removes reserved agent instructions from oversized Markdown', () => {
    const parse = vi.spyOn(Object.getPrototypeOf(unified), 'parse');
    const source = fencedMessage(MAX_MARKDOWN_CHARS + 1);
    try {
      expect(stripAgentBlocksForMarkdown(wrapAgentBlock('hidden protocol') + '\n' + source)).toBe(
        source
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('skips legacy-envelope parsing above the same size limit', () => {
    const parse = vi.spyOn(Object.getPrototypeOf(unified), 'parse');
    const source = '```sh\\n' + 'x'.repeat(MAX_MARKDOWN_CHARS) + '\\n```';
    try {
      expect(normalizeLegacyMarkdownEscapes(source)).toBe(source);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
