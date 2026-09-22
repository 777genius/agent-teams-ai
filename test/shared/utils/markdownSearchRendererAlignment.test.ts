import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';

import { createMarkdownComponents } from '../../../src/renderer/components/chat/markdownComponents';
import { createSearchContext } from '../../../src/renderer/components/chat/searchHighlightUtils';
import { findMarkdownSearchMatches } from '../../../src/shared/utils/markdownTextSearch';

function extractRenderedMatchIndexes(markdown: string, query: string): number[] {
  const parsedMatches = findMarkdownSearchMatches(markdown, query);
  const searchMatches = parsedMatches.map((m, i) => ({
    itemId: 'item-1',
    itemType: 'user' as const,
    matchIndexInItem: m.matchIndexInItem,
    globalIndex: i,
  }));
  const searchCtx = createSearchContext(query, 'item-1', searchMatches, 0);
  const components = createMarkdownComponents(searchCtx);

  const html = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], components },
      markdown
    )
  );

  return Array.from(html.matchAll(/data-search-match-index="(\d+)"/g), (m) => Number(m[1]));
}

describe('markdown search renderer alignment', () => {
  const query = 'the';
  const cases = [
    'the plain the',
    'Use `the` and then **the**.',
    '- the one\n- `the` two\n- **the** three',
    '| col | val |\n| - | - |\n| the | then |\n| other | the |',
    '```ts\nconst theValue = "the";\n```\nthen the',
    'line one  \nline two with the',
    '<context>the</context> and the',
    '/cmd <command-name>the</command-name> and the',
    '[the docs](https://example.com/the) and https://example.com/the',
    'This is ~~the~~ test with the',
  ];

  it.each(cases)('matches parser indexes for: %s', (markdown) => {
    const parsedIndexes = findMarkdownSearchMatches(markdown, query).map(
      (m) => m.matchIndexInItem
    );
    const renderedIndexes = extractRenderedMatchIndexes(markdown, query);
    expect(renderedIndexes).toEqual(parsedIndexes);
  });
});

