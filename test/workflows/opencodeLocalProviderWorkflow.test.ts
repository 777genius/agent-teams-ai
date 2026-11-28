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

  it('checks out only the reviewed SDK commit from the runtime lock', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/opencode-local-provider-app-launch.yml', import.meta.url),
        'utf8'
      )
    );
    const lock = JSON.parse(readFileSync(new URL('../../runtime.lock.json', import.meta.url), 'utf8'));
    const checkout = workflow.jobs['local-provider'].steps.find(
      (step: { with?: { path?: string } }) => step.with?.path === 'TEST-local-provider-sdk'
    );
    expect(checkout.uses).toBe('actions/checkout@v6');
    expect(checkout.with.repository).toBe(lock.opencodeV2LocalProviderCandidate.sourceRepository);
    expect(checkout.with.ref).toMatch(/^[a-f0-9]{40}$/);
    expect(checkout.with.ref).toBe(lock.opencodeV2LocalProviderCandidate.sourceCommit);
    expect(checkout.with['persist-credentials']).toBe(false);
  });
});
