import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { readOpenUIReply } from '../../scripts/lib/openui-chat-reply';
import { evaluateChatVisualization } from '../../src/features/chat-visualizations/renderer/evaluateChatVisualization';
import { createChatVisualizationParser } from '../../src/features/chat-visualizations/renderer/parseChatVisualization';
import {
  type MarkdownFence,
  readMarkdownFence,
} from '../../src/renderer/components/chat/viewers/MarkdownFence';
import { stripAgentBlocksForMarkdown } from '../../src/renderer/utils/markdownCodeRanges';
import { wrapAgentBlock } from '../../src/shared/constants/agentBlocks';

const expectedChart =
  'root = Stack([Card([BarChart(["Alpha", "Beta"], [Series("Count", [10, 20])])])]);';
const wrongChart = expectedChart.replace('[10, 20]', '[99, 88]');
const fenced = (source: string) => ['```openui-lang', source, '```'].join('\n');

function readRenderedFences(text: string): MarkdownFence[] {
  const markdown = stripAgentBlocksForMarkdown(text);
  const fences: MarkdownFence[] = [];
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: markdown,
      components: {
        pre: ({ node }) => {
          const fence = readMarkdownFence(markdown, node);
          if (fence && ['openui', 'openui-lang'].includes(fence.language ?? '')) fences.push(fence);
          return createElement('pre');
        },
      },
    })
  );
  return fences;
}

describe('visible OpenUI reply evidence', () => {
  it.each(['', expectedChart, `${expectedChart}\n`])(
    'reads exactly the code bytes supplied by the real Markdown renderer: %j',
    (source) => {
      const markdown = fenced(source);
      expect(readOpenUIReply(markdown).fences).toEqual(readRenderedFences(markdown));
    }
  );

  it.each([
    [31_999, 'content'],
    [32_000, 'limit'],
  ] as const)(
    'uses the real renderer source length at the display cap (%i source units)',
    (length, status) => {
      const prefix = 'root = Stack([Card([Table([Col("Rows", ["';
      const suffix = '"], "string")])])]);';
      const source = prefix + 'x'.repeat(length - prefix.length - suffix.length) + suffix;
      const markdown = fenced(source);
      const fences = readOpenUIReply(markdown).fences;
      expect(fences).toEqual(readRenderedFences(markdown));
      expect(fences[0].source.length).toBe(length + 1);
      expect(
        evaluateChatVisualization(createChatVisualizationParser(), fences[0].source, 'closed')
          .status
      ).toBe(status);
    }
  );

  it('validates the actual chart rather than a correct example nested in a literal code block', () => {
    const reply = readOpenUIReply(
      ['VISIBLE explanation', '````text', fenced(expectedChart), '````', fenced(wrongChart)].join(
        '\n\n'
      )
    );

    expect(reply.fences).toEqual([
      { language: 'openui-lang', source: `${wrongChart}\n`, state: 'closed' },
    ]);
    expect(reply.prose).toBe('VISIBLE explanation');
  });

  it('excludes hidden instructions and their marker from chart and prose evidence', () => {
    const reply = readOpenUIReply(
      [wrapAgentBlock(`HIDDEN_MARKER\n${fenced(expectedChart)}`), fenced(wrongChart)].join('\n\n')
    );

    expect(reply.fences.map((fence) => fence.source)).toEqual([`${wrongChart}\n`]);
    expect(reply.prose).toBe('');
  });

  it('does not count a literal-only fence example or a fenced marker as a rendered answer', () => {
    const reply = readOpenUIReply(
      ['````text', 'CODE_ONLY_MARKER', fenced(expectedChart), '````'].join('\n')
    );

    expect(reply).toEqual({ fences: [], prose: '' });
  });

  it('preserves open-fence positions so the selected closed fence matches its displayed block', () => {
    const reply = readOpenUIReply(
      [
        '> ```openui',
        '> root = Stack([]);',
        '',
        'VISIBLE_MARKER explanation',
        '',
        '~~~OPENUI-LANG',
        expectedChart,
        '~~~',
      ].join('\n')
    );

    expect(reply.fences).toEqual([
      { language: 'openui', source: 'root = Stack([]);\n', state: 'open' },
      { language: 'openui-lang', source: `${expectedChart}\n`, state: 'closed' },
    ]);
    expect(reply.fences.findIndex((fence) => fence.state === 'closed')).toBe(1);
    expect(reply.prose).toBe('VISIBLE_MARKER explanation');
  });

  it('preserves multiline literal values in evidence after removing hidden instructions', () => {
    const source = 'root = Stack([Card([TextContent("First\n\n\n\nFifth")])]);';
    const markdown = [wrapAgentBlock('hidden protocol'), fenced(source)].join('\n\n');
    const reply = readOpenUIReply(markdown);
    expect(reply.fences).toEqual(readRenderedFences(markdown));
    expect(reply.fences[0].source).toBe(`${source}\n`);
    expect(reply.prose).toBe('');
  });
});
