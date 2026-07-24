// @vitest-environment node

import { readFileSync } from 'node:fs';

import * as agentGraph from '@features/agent-graph';
import { describe, expect, it } from 'vitest';

describe('agent graph root boundary', () => {
  it('stays browser-safe and does not re-export the renderer composition layer', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository-owned module URL
    const source = readFileSync(
      new URL('../../../../src/features/agent-graph/index.ts', import.meta.url),
      'utf8'
    );
    const moduleTargets = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1]
    );

    expect(moduleTargets).not.toContain('./renderer');
    expect(moduleTargets.some((target) => target?.startsWith('@renderer'))).toBe(false);
    expect(agentGraph.createTeamGraphLayoutActions).toBeTypeOf('function');
    expect('TeamGraphAdapter' in agentGraph).toBe(false);
  });
});
