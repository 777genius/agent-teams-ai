import { describe, expect, it } from 'vitest';

import { getSuggestedSlashCommandsForProvider } from '@renderer/utils/providerSlashCommands';

describe('getSuggestedSlashCommandsForProvider', () => {
  it('returns Codex-specific command suggestions without Anthropic-only entries', () => {
    const commands = getSuggestedSlashCommandsForProvider('codex').map(
      (command) => command.command
    );

    expect(commands).toContain('/permissions');
    expect(commands).toContain('/agent');
    expect(commands).toContain('/review');
    expect(commands).not.toContain('/effort');
    expect(commands).not.toContain('/usage');
  });

  it('falls back to the default curated list for Anthropic-like providers', () => {
    const commands = getSuggestedSlashCommandsForProvider('anthropic').map(
      (command) => command.command
    );

    expect(commands).toContain('/effort');
    expect(commands).toContain('/usage');
    expect(commands).not.toContain('/permissions');
  });
});
