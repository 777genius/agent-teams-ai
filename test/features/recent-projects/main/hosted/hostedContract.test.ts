import { describe, expect, it } from 'vitest';

import { parseHostedRecentProjectsResult } from '../../../../../src/features/recent-projects/contracts/hosted';

const now = Date.parse('2026-09-30T12:00:00Z');
const row = {
  workspaceId: `workspace_${'a'.repeat(32)}`,
  label: 'Workspace 1',
  registrationRevision: 1,
  mountGeneration: 1,
  sources: [{ provider: 'anthropic', observedAt: now - 200, confirmedAt: now - 100, freshness: 'fresh' }],
  openAvailability: 'available',
};
const payload = {
  schemaVersion: 1, kind: 'recent-projects', deploymentId: 'deployment_test', bootId: 'boot_test',
  readAt: now, completeness: 'complete', projects: [row],
};

describe('Hosted recent wire contract', () => {
  it('accepts a bounded safe payload and rejects paths, duplicate providers and future activity', () => {
    expect(parseHostedRecentProjectsResult(payload, now)).toMatchObject(payload);
    let rejected = 0;
    for (const unsafe of [
      { ...payload, projects: [{ ...row, primaryPath: '/private/root' }] },
      { ...payload, projects: [{ ...row, sources: [row.sources[0], row.sources[0]] }] },
      { ...payload, projects: [{ ...row, sources: [{ ...row.sources[0], observedAt: now + 1 }] }] },
    ]) {
      try { parseHostedRecentProjectsResult(unsafe, now); } catch { rejected++; }
    }
    expect(rejected).toBe(3);
  });
});
