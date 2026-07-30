import { shouldShowWorkspaceTrustLaunchNotice } from '@features/workspace-trust/renderer';
import { describe, expect, it } from 'vitest';

describe('shouldShowWorkspaceTrustLaunchNotice', () => {
  it('shows consent when trust is missing or cannot be proven', () => {
    expect(shouldShowWorkspaceTrustLaunchNotice('untrusted')).toBe(true);
    expect(shouldShowWorkspaceTrustLaunchNotice('unknown')).toBe(true);
  });

  it('hides consent while checking or when trust automation is not applicable', () => {
    expect(shouldShowWorkspaceTrustLaunchNotice('checking')).toBe(false);
    expect(shouldShowWorkspaceTrustLaunchNotice('trusted')).toBe(false);
    expect(shouldShowWorkspaceTrustLaunchNotice('disabled')).toBe(false);
    expect(shouldShowWorkspaceTrustLaunchNotice('not_applicable')).toBe(false);
  });
});
