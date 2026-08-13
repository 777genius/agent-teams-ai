import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const DORMANT_CONSTRUCTOR =
  'src/main/composition/hosted/createHostedApprovalProductionComposition.ts';

describe('hosted approval production remains unmounted', () => {
  it('has no single-owner production constructor or production-barrel activation seam', async () => {
    await expect(access(DORMANT_CONSTRUCTOR)).rejects.toThrow();
    const [standalone, publicHosted] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/features/team-approvals/main/hosted.ts', 'utf8'),
    ]);
    expect(standalone).not.toMatch(/createHostedApprovalProductionComposition/);
    expect(publicHosted).not.toMatch(/hostedApprovalRuntimeProductCandidateRequest/);
    expect(standalone).toContain(
      'signed per-team v4 routes and exact wire capability are required'
    );
  });
});
