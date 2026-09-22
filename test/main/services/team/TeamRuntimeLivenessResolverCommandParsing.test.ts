import {
  commandArgEquals,
  extractCliArgValues,
} from '@main/services/team/TeamRuntimeLivenessResolver';
import { describe, expect, it } from 'vitest';

describe('team runtime liveness command parsing', () => {
  it('keeps cached extracted values isolated from caller mutation', () => {
    const command = 'node runtime --team-name demo --agent-id agent-alice';

    const firstValues = extractCliArgValues(command, '--agent-id');
    firstValues.push('mutated-agent');

    expect(extractCliArgValues(command, '--agent-id')).toEqual(['agent-alice']);
  });

  it('caches command arg equality without changing quoted value matching', () => {
    const command = 'node runtime --team-name "demo team" --agent-id agent-alice';

    expect(commandArgEquals(command, '--team-name', 'demo team')).toBe(true);
    expect(commandArgEquals(command, '--team-name', 'other team')).toBe(false);
    expect(commandArgEquals(command, '--agent-id', 'agent-alice')).toBe(true);
  });
});
