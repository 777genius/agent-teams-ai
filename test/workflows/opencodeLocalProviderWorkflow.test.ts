// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('OpenCode local-provider workflow security', () => {
  it('cannot write to Actions caches, including on manual dispatch', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/opencode-local-provider-app-launch.yml', import.meta.url),
        'utf8'
      )
    );
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow['cache-mode']).toBe('read');
    for (const job of Object.values(workflow.jobs) as Record<string, unknown>[]) {
      expect([undefined, 'read', 'none']).toContain(job['cache-mode']);
    }
  });
});
