import { isProductAuthorityInvalidator } from '@features/internal-storage/main/infrastructure/worker/productAuthorityMutationClassification';
import { describe, expect, it } from 'vitest';

describe('Product authority mutation classification', () => {
  it('fences publication settlement and session expiry updates', () => {
    expect(isProductAuthorityInvalidator('draftPublication.settle', {})).toBe(true);
    expect(
      isProductAuthorityInvalidator('hostedAuth.call', {
        operation: 'session.touch',
        payload: {},
      })
    ).toBe(true);
    expect(isProductAuthorityInvalidator('draftPublication.read', {})).toBe(false);
  });
});
