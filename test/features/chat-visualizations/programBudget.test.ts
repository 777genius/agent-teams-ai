import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { chatVisualizationInstructions } from '../../../src/features/chat-visualizations/renderer/chatVisualizationInstructions';
import { evaluateChatVisualization } from '../../../src/features/chat-visualizations/renderer/evaluateChatVisualization';
import { createChatVisualizationParser } from '../../../src/features/chat-visualizations/renderer/parseChatVisualization';
import { checkChatVisualizationBudget } from '../../../src/features/chat-visualizations/renderer/programBudget';

const repeated = (name: string, count: number): string => Array(count).fill(name).join(',');
const amplifiedTable =
  `column = Col("v", [${Array(100).fill(1).join(',')}]);\n` +
  `table = Table([${repeated('column', 100)}]);\n` +
  `card = Card([${repeated('table', 10)}]);\n` +
  `root = Stack([${repeated('card', 100)}]);`;

describe('OpenUI materialization budget', () => {
  it.each(['open', 'closed'] as const)(
    'rejects reference-amplified data before the SDK allocates it (%s)',
    (state) => {
      expect(amplifiedTable.length).toBeLessThan(2_000);
      const parser = createChatVisualizationParser();
      const set = vi.spyOn(parser, 'set');
      expect(evaluateChatVisualization(parser, amplifiedTable, state)).toEqual({
        status: 'limit',
        canRender: false,
      });
      expect(set).not.toHaveBeenCalled();
    }
  );

  it('counts repeated displayed strings as well as numeric data', () => {
    const source =
      `text = TextContent(${JSON.stringify('x'.repeat(10_000))});\n` +
      `card = Card([${repeated('text', 24)}]);\nroot = Stack([card]);`;
    expect(source.length).toBeLessThan(11_000);
    expect(checkChatVisualizationBudget(source)).toBe('limit');
  });

  it('keeps the real variant gallery and canonical protocol examples renderable', async () => {
    const gallery = await readFile(
      resolve(__dirname, '../../../mcp-server/test/fixtures/visualization-gallery.openui'),
      'utf8'
    );
    const examples = chatVisualizationInstructions.match(/^root = .+$/gm) ?? [];
    for (const source of [...examples, gallery]) {
      expect(evaluateChatVisualization(createChatVisualizationParser(), source, 'closed')).toEqual({
        status: 'content',
        canRender: true,
      });
    }
  });

  it('preserves 500-point charts and multiline named forward references on one parser', () => {
    const parser = createChatVisualizationParser();
    const initial = 'root = Stack([card]);';
    expect(evaluateChatVisualization(parser, initial, 'open').status).toBe('incomplete');
    const source =
      initial +
      '\ncard = Card([chart]);\n' +
      `chart = LineChart([${Array.from({ length: 500 }, (_, i) => JSON.stringify(String(i))).join(',')}], [series]);\n` +
      `series = Series("Count", [${Array(500).fill(1).join(',')}]);`;
    expect(evaluateChatVisualization(parser, source, 'closed')).toEqual({
      status: 'content',
      canRender: true,
    });
  });

  it('matches SDK comments while preserving comment markers and escaped quotes in strings', () => {
    const source =
      '# comment with unmatched ( [ "\n' +
      'root = Stack([card]); // unmatched [\n' +
      'card = Card([TextContent("#1 // literal \\"quoted\\"\nnext"), TextContent(\'it\\\'s #2 // literal\')]);';
    expect(evaluateChatVisualization(createChatVisualizationParser(), source, 'closed')).toEqual({
      status: 'content',
      canRender: true,
    });
    const withoutComments = amplifiedTable.replace(/\n/g, ' // unmatched [ "\n');
    expect(checkChatVisualizationBudget(withoutComments)).toBe('limit');
  });

  it('bounds duplicate definitions retained during partial replacements and cyclic references', () => {
    const replacement = `${amplifiedTable}\ncolumn = Col("new", []`;
    expect(checkChatVisualizationBudget(replacement)).toBe('limit');
    expect(checkChatVisualizationBudget('root = Stack([card]);\ncard = Card([card]);')).toBe(
      'limit'
    );
  });

  it('fails closed for unsupported nested wrappers and excessively deep expressions', () => {
    for (const source of [
      `\`\`\`openui\n${amplifiedTable}\n\`\`\``,
      'root = ' + '['.repeat(12_000) + '1' + ']'.repeat(12_000),
    ]) {
      const parser = createChatVisualizationParser();
      const set = vi.spyOn(parser, 'set');
      expect(evaluateChatVisualization(parser, source, 'closed').canRender).toBe(false);
      expect(set).not.toHaveBeenCalled();
    }
  });
});
