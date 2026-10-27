import { describe, expect, it } from 'vitest';

import { readOpenUIReply } from '../../scripts/lib/openui-chat-reply';
import { wrapAgentBlock } from '../../src/shared/constants/agentBlocks';

const expectedChart =
  'root = Stack([Card([BarChart(["Alpha", "Beta"], [Series("Count", [10, 20])])])]);';
const wrongChart = expectedChart.replace('[10, 20]', '[99, 88]');
const fenced = (source: string) => ['```openui-lang', source, '```'].join('\n');

describe('visible OpenUI reply evidence', () => {
  it('validates the actual chart rather than a correct example nested in a literal code block', () => {
    const reply = readOpenUIReply(
      ['VISIBLE explanation', '````text', fenced(expectedChart), '````', fenced(wrongChart)].join(
        '\n\n'
      )
    );

    expect(reply.fences).toEqual([
      { language: 'openui-lang', source: wrongChart, state: 'closed' },
    ]);
    expect(reply.prose).toBe('VISIBLE explanation');
  });

  it('excludes hidden instructions and their marker from chart and prose evidence', () => {
    const reply = readOpenUIReply(
      [wrapAgentBlock(`HIDDEN_MARKER\n${fenced(expectedChart)}`), fenced(wrongChart)].join('\n\n')
    );

    expect(reply.fences.map((fence) => fence.source)).toEqual([wrongChart]);
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
      { language: 'openui', source: 'root = Stack([]);', state: 'open' },
      { language: 'openui-lang', source: expectedChart, state: 'closed' },
    ]);
    expect(reply.fences.findIndex((fence) => fence.state === 'closed')).toBe(1);
    expect(reply.prose).toBe('VISIBLE_MARKER explanation');
  });
});
