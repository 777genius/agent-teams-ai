import {
  linkifyAllMentionsInMarkdown,
  linkifyMentionsInMarkdown,
  linkifyTeamMentionsInMarkdown,
} from '@renderer/utils/mentionLinkify';
import { describe, expect, it } from 'vitest';

describe('mentionLinkify', () => {
  it('linkifies @member after space', () => {
    const m = new Map([['Alice', 'blue']]);
    const r = linkifyMentionsInMarkdown('hello @Alice world', m);
    expect(r).toContain('mention://');
    expect(r).toContain('Alice');
    expect(r).not.toBe('hello @Alice world');
  });

  it('does NOT linkify @ in email', () => {
    const m = new Map([['Alice', 'blue']]);
    const r = linkifyMentionsInMarkdown('email@test.com', m);
    expect(r).toBe('email@test.com');
  });

  it('linkifies @team after (', () => {
    const r = linkifyTeamMentionsInMarkdown('(@TeamAlpha)', ['TeamAlpha']);
    expect(r).toContain('team://');
    expect(r).toContain('TeamAlpha');
  });

  it('linkifyAll applies both member and team', () => {
    const m = new Map([['Alice', 'blue']]);
    const r = linkifyAllMentionsInMarkdown('Hi @Alice from @TeamX', m, ['TeamX']);
    expect(r).toContain('mention://');
    expect(r).toContain('team://');
  });

  it.each(['```openui-lang', '~~~OPENUI', '````text'])(
    'preserves code data inside %s while linking surrounding mentions',
    (opener) => {
      const delimiter = /^[`~]+/.exec(opener)![0];
      const source = 'root = Stack([Card([TextContent("@Alice work from @TeamX here")])]);';
      const block = `${opener}\n${source}\n${delimiter}`;
      const text = `Hi @Alice from @TeamX\n\n${block}\n\nAfter @Alice`;
      const result = linkifyAllMentionsInMarkdown(text, new Map([['Alice', 'blue']]), ['TeamX']);
      expect(result).toBe(
        `Hi [@Alice](mention://blue/Alice) from [TeamX](team://TeamX)\n\n${block}\n\nAfter [@Alice](mention://blue/Alice)`
      );
    }
  );

  it('preserves inline code and an open fenced block', () => {
    const code = '`@Alice work` and ``@TeamX work``\n\n> ~~~openui\n> @Alice @TeamX';
    expect(linkifyAllMentionsInMarkdown(code, new Map([['Alice', 'blue']]), ['TeamX'])).toBe(code);
  });

  it('links table-cell mentions when literal backticks occur in different GFM cells', () => {
    const table = '| Command | Owner |\n| --- | --- |\n| `foo | @Alice |\n| bar` | @Bob |';
    expect(
      linkifyMentionsInMarkdown(
        table,
        new Map([
          ['Alice', 'blue'],
          ['Bob', 'red'],
        ])
      )
    ).toBe(
      '| Command | Owner |\n| --- | --- |\n| `foo | [@Alice](mention://blue/Alice) |\n| bar` | [@Bob](mention://red/Bob) |'
    );
  });

  it('linkifies @ after start of string', () => {
    const m = new Map([['Alice', 'blue']]);
    const r = linkifyMentionsInMarkdown('@Alice hello', m);
    expect(r).toContain('mention://');
  });

  it('linkifies @ after [ { (', () => {
    const m = new Map([['Bob', 'red']]);
    expect(linkifyMentionsInMarkdown('[@Bob]', m)).toContain('mention://');
    expect(linkifyMentionsInMarkdown('{@Bob}', m)).toContain('mention://');
    expect(linkifyMentionsInMarkdown('(@Bob)', m)).toContain('mention://');
  });

  it('does NOT linkify @ when followed by word char', () => {
    const m = new Map([['Alice', 'blue']]);
    expect(linkifyMentionsInMarkdown('@AliceX', m)).toBe('@AliceX');
    expect(linkifyMentionsInMarkdown('@Alice123', m)).toBe('@Alice123');
  });

  it('linkifies when followed by boundary: space, comma, dot, ), ], }', () => {
    const m = new Map([['Alice', 'blue']]);
    expect(linkifyMentionsInMarkdown('@Alice ', m)).toContain('mention://');
    expect(linkifyMentionsInMarkdown('@Alice,', m)).toContain('mention://');
    expect(linkifyMentionsInMarkdown('@Alice.', m)).toContain('mention://');
    expect(linkifyMentionsInMarkdown('@Alice)', m)).toContain('mention://');
    expect(linkifyMentionsInMarkdown('@Alice]', m)).toContain('mention://');
    expect(linkifyMentionsInMarkdown('@Alice}', m)).toContain('mention://');
  });
});
