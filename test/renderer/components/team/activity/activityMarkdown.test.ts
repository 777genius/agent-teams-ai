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

  it.each(['```sh', '~~~sh'])(
    'restores closed fences in fully escape-encoded legacy messages (%s)',
    (opener) => {
      const delimiter = opener.slice(0, 3);
      for (const prefix of ['', 'Before\n\n']) {
        const decoded = `${prefix}${opener}\nls\n${delimiter}  \n\nAfter`;
        const text = decoded.replace(/\n/g, '\\n');
        expect(
          getStrippedActivityTextCached({
            message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
            structured: null,
            hasBootstrapDisplay: false,
            isCrossTeamAny: false,
          })
        ).toBe(decoded);
      }
    }
  );

  it.each(['```sh', '~~~sh'])(
    'preserves unrelated inline paths and nested examples around an encoded fence (%s)',
    (opener) => {
      const path = '`' + String.raw`C:\new\test` + '`';
      const triplePath = '```' + String.raw`C:\new\test` + '```';
      const nestedExample = '`' + String.raw`\n~~~sh\nls\n~~~\n` + '`';
      const delimiter = opener.slice(0, 3);
      const serializedFence = `${opener}\\nls\\n${delimiter}`;
      for (const prefix of ['', `${path}\\n\\n`]) {
        const text = `${prefix}${serializedFence}\\n\\nAfter ${triplePath} ${nestedExample}`;
        expect(
          getStrippedActivityTextCached({
            message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
            structured: null,
            hasBootstrapDisplay: false,
            isCrossTeamAny: false,
          })
        ).toBe(
          `${prefix ? path + '\n\n' : ''}${opener}\nls\n${delimiter}\n\nAfter ${triplePath} ${nestedExample}`
        );
      }
    }
  );

  it('restores multiple serialized fences while preserving inline paths between them', () => {
    const path = '`' + String.raw`C:\new\test` + '`';
    const text = `~~~sh\\nls\\n~~~\\n\\n${path}\\n\\n\`\`\`js\\nrun()\\n\`\`\``;
    expect(
      getStrippedActivityTextCached({
        message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
        structured: null,
        hasBootstrapDisplay: false,
        isCrossTeamAny: false,
      })
    ).toBe(`~~~sh\nls\n~~~\n\n${path}\n\n\`\`\`js\nrun()\n\`\`\``);
  });

  it.each([1, 2])(
    'keeps body backticks inside %s serialized tilde fences from consuming outside inline paths',
    (count) => {
      const path = '`' + String.raw`C:\new\test` + '`';
      const fence = '~~~text\nliteral ` tick\n~~~';
      const decoded = Array.from({ length: count }, () => `${fence}\n\nPath ${path}`).join('\n\n');
      const text = decoded.replace(/\n/g, '\\n');
      expect(
        getStrippedActivityTextCached({
          message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
          structured: null,
          hasBootstrapDisplay: false,
          isCrossTeamAny: false,
        })
      ).toBe(decoded);
    }
  );

  it('restores a longer closing fence without pairing it with a later backtick block', () => {
    const decoded = '```sh\nls\n````\n\n```js\nrun()\n```';
    const text = decoded.replace(/\n/g, '\\n');
    expect(
      getStrippedActivityTextCached({
        message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
        structured: null,
        hasBootstrapDisplay: false,
        isCrossTeamAny: false,
      })
    ).toBe(decoded);
  });

  it.each([
    String.raw`C:\new\test`,
    String.raw`\\server\new\test`,
    String.raw`folder\new\test`,
    ' ' + String.raw`C:\new\test` + ' ',
  ])('preserves a triple-backtick inline path before a serialized fence: %s', (value) => {
    const path = '```' + value + '```';
    const text = `${path}\\n\\n\`\`\`sh\\nls\\n\`\`\``;
    expect(
      getStrippedActivityTextCached({
        message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
        structured: null,
        hasBootstrapDisplay: false,
        isCrossTeamAny: false,
      })
    ).toBe(`${path}\n\n\`\`\`sh\\nls\\n\`\`\``);
  });

  it('treats an encoded tab after an early inline close as logical-line whitespace', () => {
    const path = '```' + String.raw`folder\new\test` + '```';
    const text = `${path}\\t\\n\\n\`\`\`sh\\nls\\n\`\`\``;
    expect(
      getStrippedActivityTextCached({
        message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
        structured: null,
        hasBootstrapDisplay: false,
        isCrossTeamAny: false,
      })
    ).toBe(`${path}\t\n\n\`\`\`sh\\nls\\n\`\`\``);
  });

  it.each(['single', 'path after', 'two fences'])(
    'restores serialized fences containing midline triple backticks (%s)',
    (scenario) => {
      const fence = '```text\nliteral ``` ticks\n```';
      const path = '```' + String.raw`C:\new\test` + '```';
      const withPath = `${fence}\n\nPath ${path}`;
      const decoded =
        scenario === 'single'
          ? fence
          : scenario === 'path after'
            ? withPath
            : `${withPath}\n\n${withPath}`;
      const text = decoded.replace(/\n/g, '\\n');
      expect(
        getStrippedActivityTextCached({
          message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
          structured: null,
          hasBootstrapDisplay: false,
          isCrossTeamAny: false,
        })
      ).toBe(decoded);
    }
  );

  it.each([
    '```' + String.raw`C:\new\test` + '```',
    '`\\n```sh\\nls\\n```\\n`',
    '`' + String.raw`\n~~~sh\nls\n~~~\n` + '`',
  ])('does not reinterpret genuine inline literals as serialized fenced blocks: %s', (text) => {
    expect(
      getStrippedActivityTextCached({
        message: { from: 'alice', text, timestamp: '2026-10-27T00:00:00Z', read: true },
        structured: null,
        hasBootstrapDisplay: false,
        isCrossTeamAny: false,
      })
    ).toBe(text);
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
