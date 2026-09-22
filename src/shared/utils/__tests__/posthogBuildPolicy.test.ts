import { describe, expect, it } from 'vitest';

import { isOfficialPostHogReleaseBuild, resolvePostHogBuildKey } from '../posthogBuildPolicy';

describe('PostHog build policy', () => {
  it('keeps the key out of dev and local production-mode builds', () => {
    const localEnv = { POSTHOG_KEY: 'phc_local' };

    expect(resolvePostHogBuildKey({}, localEnv)).toBe('');
    expect(
      resolvePostHogBuildKey(
        { NODE_ENV: 'production', RELEASE_CHANNEL: 'production', POSTHOG_KEY: 'phc_local' },
        localEnv
      )
    ).toBe('');
  });

  it('includes the key only for an explicitly marked official release', () => {
    expect(isOfficialPostHogReleaseBuild({ IS_RELEASE_BUILD: 'true' })).toBe(true);
    expect(
      resolvePostHogBuildKey(
        { IS_RELEASE_BUILD: 'true', POSTHOG_KEY: 'phc_release' },
        { POSTHOG_KEY: 'phc_local' }
      )
    ).toBe('phc_release');
  });

  it('does not treat a local release tag as an official marker', () => {
    expect(resolvePostHogBuildKey({}, { RELEASE_TAG: 'v9.9.9', POSTHOG_KEY: 'phc_local' })).toBe(
      ''
    );
  });
});
