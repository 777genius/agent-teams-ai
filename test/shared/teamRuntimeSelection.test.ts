import { describe, expect, it } from 'vitest';
import { resolveTeamRuntimeSelection } from '../../src/shared/utils/teamRuntimeSelection';

describe('explicit team runtime selection', () => {
  it.each([
    [{}, { status: 'selected', providerId: 'anthropic' }],
    [{ providerId: 'codex' }, { status: 'selected', providerId: 'codex' }],
    [{ runtimeSelectionVersion: 1 }, { status: 'unresolved' }],
    [
      { runtimeSelectionVersion: 1, providerId: 'opencode' },
      { status: 'selected', providerId: 'opencode' },
    ],
    [{ runtimeSelectionVersion: 2 }, 'unsupported'],
    [{ runtimeSelectionVersion: null }, 'unsupported'],
  ] as const)('resolves %j without silently changing authority', (input, expected) => {
    if (expected === 'unsupported')
      expect(() => resolveTeamRuntimeSelection(input)).toThrow('RUNTIME_SELECTION_UNSUPPORTED');
    else expect(resolveTeamRuntimeSelection(input)).toEqual(expected);
  });
});
