import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
import {
  chatVisualizationInstructions,
  chatVisualizationLibrary,
} from '../../../src/features/chat-visualizations/renderer/protocol';

const finalProgram =
  'root = Stack([Card([CardHeader("Report", "Summary"), Table([Col("Name", ["Alpha", "Beta"], "string"), Col("Value", [10, 20], "number")]), BarChart(["Alpha", "Beta"], [Series("Count", [10, 20])])])]);';
describe('real OpenUI display contract', () => {
  it('accepts every canonical agent example through the production parser and display guards', () => {
    const examples = chatVisualizationInstructions.match(/^root = .+$/gm) ?? [];
    expect(examples.length).toBeGreaterThanOrEqual(2);
    const displayTypes = new Set<string>();
    for (const source of examples) {
      const parsed = parseChatVisualization(source);
      expect(parsed.meta.errors, source).toEqual([]);
      expect(guardChatVisualizationProgram(parsed, 'closed'), source).toEqual({ status: 'ready' });
      expect(
        evaluateChatVisualization(createChatVisualizationParser(), source, 'closed'),
        source
      ).toEqual({ status: 'content', canRender: true });
      const cards = parsed.root?.props.children as {
        props: { children: { typeName: string }[] };
      }[];
      for (const card of cards) {
        for (const content of card.props.children) displayTypes.add(content.typeName);
      }
    }
    for (const type of ['Table', 'BarChart', 'LineChart', 'PieChart']) {
      expect(displayTypes.has(type), type).toBe(true);
    }
  });
  it('accepts the same full variant gallery sent by the built MCP transport test', async () => {
    const source = await readFile(
      resolve(__dirname, '../../../mcp-server/test/fixtures/visualization-gallery.openui'),
      'utf8'
    );
    const parsed = parseChatVisualization(source);
    expect(parsed.meta.errors).toEqual([]);
    expect(guardChatVisualizationProgram(parsed, 'closed')).toEqual({ status: 'ready' });
    expect(evaluateChatVisualization(createChatVisualizationParser(), source, 'closed')).toEqual({
      status: 'content',
      canRender: true,
    });
    const cards = parsed.root?.props.children as {
      props: { children: { typeName: string; props: Record<string, unknown> }[] };
    }[];
    const content = cards.flatMap((card) => card.props.children);
    const variants = (type: string) =>
      content.filter((node) => node.typeName === type).map((node) => node.props.variant);
    expect(variants('BarChart')).toEqual(['grouped', 'stacked']);
    expect(variants('LineChart')).toEqual(['linear', 'natural', 'step']);
    expect(
      content
        .filter((node) => node.typeName === 'PieChart')
        .map((node) => [node.props.variant, node.props.appearance])
    ).toEqual([
      ['pie', 'circular'],
      ['pie', 'semiCircular'],
      ['donut', 'circular'],
      ['donut', 'semiCircular'],
    ]);
    expect(
      content.filter((node) => node.typeName === 'TextContent').map((node) => node.props.size)
    ).toEqual(['small', 'default', 'large', 'small-heavy', 'large-heavy']);
    const table = content.find((node) => node.typeName === 'Table');
    const columns = table?.props.columns as { props: { data: unknown[] } }[];
    expect(columns.map((column) => column.props.data)).toEqual([
      ['Alpha', 'Beta'],
      [10, 20],
      [true, false],
      [null, 'Available'],
    ]);
  });
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
  it('advertises the inclusive source/message caps and enforces the source cap in JavaScript string units', () => {
    expect(chatVisualizationInstructions).toContain(
      "each openui-lang block's source at or below 32,000 UTF-16 code units (JavaScript string.length)"
    );
    expect(chatVisualizationInstructions).toContain(
      'the complete enclosing message, including prose and fences, at or below 60,000 in the same units'
    );
    const prefix = 'root = Stack([Card([Table([Col("Rows", ["';
    const suffix = '"], "string")])])]);';
    const source = prefix + 'x'.repeat(32_000 - prefix.length - suffix.length - 2) + '😀' + suffix;
    expect(source.length).toBe(32_000);
    expect(guardChatVisualizationProgram(parseChatVisualization(source), 'closed')).toEqual({
      status: 'ready',
    });
    expect(evaluateChatVisualization(createChatVisualizationParser(), source, 'closed')).toEqual({
      status: 'content',
      canRender: true,
    });
    expect(
      evaluateChatVisualization(createChatVisualizationParser(), source + '\n', 'closed')
    ).toEqual({ status: 'limit', canRender: false });
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
  it.each(['BarChart', 'LineChart'])(
    'rejects %s series names that overwrite SDK chart data',
    (kind) => {
      for (const names of [['category'], ['__proto__'], ['Count', 'Count']]) {
        const series = names
          .map((name, index) => `Series(${JSON.stringify(name)}, [${index + 1}, ${index + 2}])`)
          .join(', ');
        const parsed = parseChatVisualization(
          `root = Stack([Card([${kind}(["Alpha", "Beta"], [${series}])])]);`
        );
        expect(parsed.meta.errors).toEqual([]);
        for (const state of ['open', 'closed'] as const) {
          expect(guardChatVisualizationProgram(parsed, state).status, names.join(', ')).toBe(
            'rejected'
          );
        }
      }
      const safeChart = `${kind}(["Alpha", "Beta"], [Series("Count", [1, 2])])`;
      const separateCharts = parseChatVisualization(
        `root = Stack([Card([${safeChart}, ${safeChart}])]);`
      );
      expect(guardChatVisualizationProgram(separateCharts, 'closed').status).toBe('ready');
    }
  );
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
