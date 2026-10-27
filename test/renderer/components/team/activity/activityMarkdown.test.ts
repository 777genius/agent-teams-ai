import { parseChatVisualization } from '@features/chat-visualizations/renderer/parseChatVisualization';
import { guardChatVisualizationProgram } from '@features/chat-visualizations/renderer/programGuards';
import { buildThoughtDisplayContent } from '@renderer/components/team/activity/activityMarkdown';
import { getStrippedActivityTextCached } from '@renderer/components/team/activity/activityMessagePresentation';
import { describe, expect, it } from 'vitest';

describe('literal visualization data in message presentation', () => {
  it.each(['```openui-lang', '~~~OPENUI'])(
    'keeps multiline OpenUI text unchanged in a lead thought (%s)',
    (opener) => {
      const source = 'root = Stack([Card([TextContent("First\nSecond @alice work #1")])]);';
      const delimiter = opener.match(/^[`~]+/)![0];
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
});
