import { shouldShowWorkspaceTrustLaunchNotice } from '@features/workspace-trust/renderer';
import { describe, expect, it } from 'vitest';

describe('shouldShowWorkspaceTrustLaunchNotice', () => {
  it('shows consent only when the project is proven untrusted', () => {
    expect(shouldShowWorkspaceTrustLaunchNotice('untrusted')).toBe(true);
  });

  it('hides consent when trust is not proven untrusted', () => {
    expect(shouldShowWorkspaceTrustLaunchNotice('unknown')).toBe(false);
    expect(shouldShowWorkspaceTrustLaunchNotice('checking')).toBe(false);
    expect(shouldShowWorkspaceTrustLaunchNotice('trusted')).toBe(false);
    expect(shouldShowWorkspaceTrustLaunchNotice('disabled')).toBe(false);
    expect(shouldShowWorkspaceTrustLaunchNotice('not_applicable')).toBe(false);
  });
});
