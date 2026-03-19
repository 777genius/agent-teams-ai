import { describe, expect, it } from 'vitest';

import {
  linkifyAllMentionsInMarkdown,
  linkifyMentionsInMarkdown,
  linkifyTeamMentionsInMarkdown,
} from '@renderer/utils/mentionLinkify';

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
