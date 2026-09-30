import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// agent_teams_orchestrator keeps the same bytes in docs/ and pins this digest: its task writer
// sends every recorded input and accepts every recorded answer. Regenerating the cases
// (mcp-server/test/hostedTaskCommand.e2e.test.ts) means updating the Owner copy and both pins.
const GOLDEN_SHA256 = '68ce5ed8b0ae3bba7c2d8dbe365941d1e137111c3e800513b3b1153ac141ce74';

describe('hosted task command golden', () => {
  it('is the file the Owner pins', () => {
    const raw = readFileSync(resolve('docs/hosted-task-command-golden.json'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA256);
  });
});
