import { describe, expect, it } from 'vitest';

import { summarizeVisualizationFences } from '../../../src/features/chat-visualizations/contracts';
import { evaluateChatVisualization } from '../../../src/features/chat-visualizations/renderer/evaluateChatVisualization';
import {
  createChatVisualizationParser,
  parseChatVisualization,
} from '../../../src/features/chat-visualizations/renderer/parseChatVisualization';
import {
  guardChatVisualizationNode,
  guardChatVisualizationProgram,
} from '../../../src/features/chat-visualizations/renderer/programGuards';
import { chatVisualizationLibrary } from '../../../src/features/chat-visualizations/renderer/protocol';

const finalProgram =
  'root = Stack([Card([CardHeader("Report", "Summary"), Table([Col("Name", ["Alpha", "Beta"], "string"), Col("Value", [10, 20], "number")]), BarChart(["Alpha", "Beta"], [Series("Count", [10, 20])])])]);';
describe('real OpenUI display contract', () => {
  it('serializes references and parses independent title/table/chart data', () => {
    expect(Object.keys(chatVisualizationLibrary.toSpec().components)).toHaveLength(10);
    expect(() => chatVisualizationLibrary.toJSONSchema()).not.toThrow();
    const parsed = parseChatVisualization(finalProgram);
    expect(parsed.meta.errors).toEqual([]);
    expect(guardChatVisualizationProgram(parsed, 'closed')).toEqual({ status: 'ready' });
    expect(parsed.root).toMatchObject({
      props: {
        children: [
          {
            props: {
              children: [
                { props: { title: 'Report' } },
                {
                  props: {
                    columns: [
                      { props: { data: ['Alpha', 'Beta'] } },
                      { props: { data: [10, 20] } },
                    ],
                  },
                },
                { props: { series: [{ props: { category: 'Count', values: [10, 20] } }] } },
              ],
            },
          },
        ],
      },
    });
  });
  it('resolves forward references progressively on one parser', () => {
    const parser = createChatVisualizationParser();
    const start = 'root = Stack([summary]);';
    expect(evaluateChatVisualization(parser, start, 'open').status).toBe('incomplete');
    const next = start + '\nsummary = Card([CardHeader("Report"), TextContent("Hello")]);';
    expect(evaluateChatVisualization(parser, next, 'closed')).toEqual({
      status: 'content',
      canRender: true,
    });
    expect(
      evaluateChatVisualization(parser, next.replace('Hello', 'Updated'), 'closed').status
    ).toBe('content');
  });
  it('rejects dynamic expressions, state, queries and unknown calls before mounting', () => {
    for (const source of [
      'root = Stack([Card([TextContent(1 + 2)])]);',
      '$count = 1; root = Stack([]);',
      'root = Stack([]);\ndata = Query("remote", {});',
      'root = Stack([Card([Unknown("x")])]);',
    ])
      expect(
        evaluateChatVisualization(createChatVisualizationParser(), source, 'closed').canRender,
        source
      ).toBe(false);
  });
  it('checks open-fence bounds and invalid siblings after pending children', () => {
    expect(
      guardChatVisualizationNode(
        {
          typeName: 'PieChart',
          props: { labels: Array(501).fill('x'), values: Array(501).fill(1) },
        },
        'open'
      ).status
    ).toBe('rejected');
    expect(
      guardChatVisualizationNode(
        {
          typeName: 'Card',
          props: {
            children: [null, { typeName: 'TextContent', props: { text: 'x'.repeat(10001) } }],
          },
        },
        'open'
      ).status
    ).toBe('rejected');
    expect(
      guardChatVisualizationNode(
        {
          typeName: 'Table',
          props: {
            columns: [{ typeName: 'Col', props: { label: 'x', data: [{ typeName: 'Image' }] } }],
          },
        },
        'open'
      ).status
    ).toBe('rejected');
    expect(
      guardChatVisualizationNode(
        { typeName: 'BarChart', props: { labels: ['x'], series: [], height: 601 } },
        'open'
      ).status
    ).toBe('rejected');
    expect(
      evaluateChatVisualization(createChatVisualizationParser(), 'x'.repeat(32001), 'open')
    ).toEqual({ status: 'limit', canRender: false });
  });
});
describe('Markdown compact projection', () => {
  it('preserves prose following an unclosed blockquote code fence', () => {
    expect(
      summarizeVisualizationFences('> ```openui\n> root = Stack([])\n\nVisible prose')
    ).toContain('Visible prose');
  });
  it('projects actual code nodes but preserves literal fence examples', () => {
    const source = 'Before\n\n```openui-lang\nroot = Stack([]);\n```\nAfter';
    expect(summarizeVisualizationFences(source)).toBe('Before\n\nVisualization\nAfter');
    expect(summarizeVisualizationFences('<pre>\n```openui\nexample\n```\n</pre>')).toContain(
      'example'
    );
    expect(summarizeVisualizationFences('````text\n```openui\nexample\n```\n````')).toContain(
      'example'
    );
    expect(summarizeVisualizationFences('- ```mermaid\n  graph TD; A-->B\n  ```')).toContain(
      'Diagram'
    );
  });
});
