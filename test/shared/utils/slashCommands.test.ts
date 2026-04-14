import { describe, expect, it } from 'vitest';

import {
  getKnownSlashCommand,
  isSupportedSlashCommandName,
  KNOWN_SLASH_COMMANDS,
  parseStandaloneSlashCommand,
} from '@shared/utils/slashCommands';

describe('slashCommands', () => {
  it('exposes exactly the curated known commands', () => {
    expect(KNOWN_SLASH_COMMANDS.map((command) => command.command)).toEqual([
      '/compact',
      '/clear',
      '/reset',
      '/new',
      '/plan',
      '/model',
      '/effort',
      '/fast',
      '/cost',
      '/usage',
    ]);
  });

  it('parses known standalone slash commands', () => {
    expect(parseStandaloneSlashCommand('  /compact keep kanban  ')).toEqual({
      name: 'compact',
      command: '/compact',
      args: 'keep kanban',
      raw: '/compact keep kanban',
      startIndex: 2,
      endIndex: 22,
    });
  });

  it('parses unknown standalone slash commands', () => {
    expect(parseStandaloneSlashCommand('/foo bar')).toEqual({
      name: 'foo',
      command: '/foo',
      args: 'bar',
      raw: '/foo bar',
      startIndex: 0,
      endIndex: 8,
    });
  });

  it('rejects slash-like text that is not a standalone command', () => {
    expect(parseStandaloneSlashCommand('please run /compact now')).toBeNull();
    expect(parseStandaloneSlashCommand('/')).toBeNull();
  });

  it('returns metadata for known commands only', () => {
    expect(getKnownSlashCommand('MODEL')?.description).toContain('Claude model');
    expect(getKnownSlashCommand('foo')).toBeNull();
  });

  it('validates slash-compatible command names', () => {
    expect(isSupportedSlashCommandName('review')).toBe(true);
    expect(isSupportedSlashCommandName('skill:name')).toBe(true);
    expect(isSupportedSlashCommandName('my_skill')).toBe(false);
    expect(isSupportedSlashCommandName('my skill')).toBe(false);
  });
});
