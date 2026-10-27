import { parseChatVisualization } from '@features/chat-visualizations/renderer/parseChatVisualization';
import { guardChatVisualizationProgram } from '@features/chat-visualizations/renderer/programGuards';
import { buildThoughtDisplayContent } from '@renderer/components/team/activity/activityMarkdown';
import { getStrippedActivityTextCached } from '@renderer/components/team/activity/activityMessagePresentation';
import { stripAgentBlocksForMarkdown } from '@renderer/utils/markdownCodeRanges';
import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { describe, expect, it } from 'vitest';

describe('literal visualization data in message presentation', () => {
  it.each(['```openui-lang', '~~~OPENUI'])(
    'keeps multiline OpenUI text unchanged in a lead thought (%s)',
    (opener) => {
      const source = 'root = Stack([Card([TextContent("First\nSecond @alice work #1")])]);';
      const delimiter = /^[`~]+/.exec(opener)![0];
      const block = `${opener}\n${source}\n${delimiter}`;
      const shown = buildThoughtDisplayContent(
        { text: `Before\nsecond\n\n${block}\n\nAfter` },
        new Map([['alice', 'blue']])
      );
      expect(shown).toBe(`Before  \nsecond  \n  \n${block}  \n  \nAfter`);
      const shownSource = shown.slice(
        shown.indexOf(opener) + opener.length + 1,
        shown.lastIndexOf(delimiter)
      );
      const parsed = parseChatVisualization(shownSource);
      expect(guardChatVisualizationProgram(parsed, 'closed')).toEqual({ status: 'ready' });
      expect(parsed.root).toEqual(parseChatVisualization(source).root);
    }
  );

  it('keeps escapes in inline code while normalizing legacy prose newlines and tabs', () => {
    const code = '`' + String.raw`C:\\new\\test` + '`';
    const text = String.raw`Before\n\tready ` + code;
    expect(
      getStrippedActivityTextCached({
        message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
        structured: null,
        hasBootstrapDisplay: false,
        isCrossTeamAny: false,
      })
    ).toBe('Before\n\tready ' + code);
  });

  it('preserves repeated blank lines in visualization values while cleaning thought prose', () => {
    const source = 'root = Stack([Card([TextContent("First\n\n\n\nFifth")])]);';
    const block = `\`\`\`openui\n${source}\n\`\`\``;
    const shown = buildThoughtDisplayContent(
      {
        text:
          'Before\n\n\n' +
          '<teammate-message teammate_id="alice">hidden protocol</teammate-message>' +
          `\n\n\n${block}\n\n\nAfter`,
      },
      undefined,
      [],
      { preserveLineBreaks: false }
    );
    expect(shown).toBe(`Before\n\n${block}\n\nAfter`);
    const shownSource = shown.slice(shown.indexOf('openui\n') + 7, shown.lastIndexOf('```'));
    expect(parseChatVisualization(shownSource).root).toEqual(parseChatVisualization(source).root);
  });

  it('removes reserved agent blocks without collapsing visualization data on rich-text paths', () => {
    const source = 'root = Stack([Card([TextContent("First\n\n\n\nFifth")])]);';
    const block = `\`\`\`openui\n${source}\n\`\`\``;
    const text = `${wrapAgentBlock('hidden protocol')}\n\nBefore\n\n\n${block}\n\n\nAfter`;
    const expected = `Before\n\n${block}\n\nAfter`;
    expect(stripAgentBlocksForMarkdown(text)).toBe(expected);
    expect(
      buildThoughtDisplayContent({ text }, undefined, [], {
        preserveLineBreaks: false,
        stripAgentOnlyBlocks: true,
      })
    ).toBe(expected);
    const shown = getStrippedActivityTextCached({
      message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
      structured: null,
      hasBootstrapDisplay: false,
      isCrossTeamAny: false,
    });
    expect(shown).toBe(expected);
    const shownSource = shown!.slice(shown!.indexOf('openui\n') + 7, shown!.lastIndexOf('```'));
    expect(parseChatVisualization(shownSource).root).toEqual(parseChatVisualization(source).root);
  });
});
