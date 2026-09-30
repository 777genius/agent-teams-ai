import { describe, expect, it } from 'vitest';

import {
  buildStandaloneSlashCommandMeta,
  parseStandaloneSlashCommand,
} from './standaloneSlashCommand';

describe('standaloneSlashCommand', () => {
  it('normalizes commands while preserving their trimmed raw text', () => {
    expect(parseStandaloneSlashCommand('  /MODEL  gpt-5  ')).toEqual({
      name: 'model',
      command: '/model',
      args: 'gpt-5',
      raw: '/MODEL  gpt-5',
    });
  });

  it('rejects text that is not a standalone command', () => {
    expect(parseStandaloneSlashCommand('please run /compact now')).toBeNull();
    expect(parseStandaloneSlashCommand('/')).toBeNull();
  });

  it('adds descriptions only for known commands', () => {
    const model = parseStandaloneSlashCommand('/model gpt-5');
    const custom = parseStandaloneSlashCommand('/review staged');

    expect(model && buildStandaloneSlashCommandMeta(model)).toEqual({
      name: 'model',
      command: '/model',
      args: 'gpt-5',
      knownDescription: 'Select or change the active model.',
    });
    expect(custom && buildStandaloneSlashCommandMeta(custom)).toEqual({
      name: 'review',
      command: '/review',
      args: 'staged',
    });
  });
});
