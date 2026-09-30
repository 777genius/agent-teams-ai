import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildOpenCodeRuntimeMessageText } from '../OpenCodeRuntimeMessageText';

import type { OpenCodeTeamRuntimeMessageInput } from '../OpenCodeTeamRuntimeAdapter';

// The same bytes live in agent_teams_orchestrator docs/; both repositories pin this digest.
const GOLDEN_SHA256 = '06a45a0dd5e67898749a46e7f04ad04907d010413c038a18b6e55ff689e6794c';

interface Golden {
  readonly format: string;
  readonly cases: readonly {
    readonly name: string;
    readonly input: Omit<OpenCodeTeamRuntimeMessageInput, 'cwd'>;
    readonly expectedText: string;
  }[];
}

describe('buildOpenCodeRuntimeMessageText cross-repository golden', () => {
  it('matches the orchestrator copy for every shared case', () => {
    const raw = readFileSync(resolve('docs/opencode-runtime-message-text-golden.json'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256);
    const golden = JSON.parse(raw.toString('utf8')) as Golden;
    expect(golden.format).toBe('agent-teams.opencode-runtime-message-text-golden/v1');
    expect(golden.cases.length).toBeGreaterThan(0);
    for (const entry of golden.cases) {
      expect({
        name: entry.name,
        text: buildOpenCodeRuntimeMessageText({ ...entry.input, cwd: '/golden' }),
      }).toEqual({ name: entry.name, text: entry.expectedText });
    }
  });
});
