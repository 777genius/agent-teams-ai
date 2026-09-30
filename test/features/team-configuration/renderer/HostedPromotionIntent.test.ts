import { webcrypto } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostedPromotionIdempotencyKey } from '../../../../src/features/team-configuration/renderer/view-models/hostedPromotionIntent';
import { parseRevision, parseTeamId, parseWorkspaceId } from '../../../../src/shared/contracts/hosted';

describe('hosted promotion retry identity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reuses the key after reload and changes it for a new saved revision', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const input = {
      workspaceId: parseWorkspaceId(`workspace_${'1'.repeat(32)}`),
      teamId: parseTeamId(`team_${'2'.repeat(32)}`),
      expectedRevision: parseRevision('revision_saved-1'),
    };
    const first = await hostedPromotionIdempotencyKey(input);
    expect(await hostedPromotionIdempotencyKey({ ...input })).toBe(first);
    expect(first).toMatch(/^idempotency_promotion_[a-f0-9]{64}$/);
    expect(await hostedPromotionIdempotencyKey({
      ...input, expectedRevision: parseRevision('revision_saved-2'),
    })).not.toBe(first);
  });
});
