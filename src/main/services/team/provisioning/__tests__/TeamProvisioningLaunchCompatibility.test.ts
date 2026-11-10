import { describe, expect, it } from 'vitest';

import { TeamLaunchValidationError } from '../TeamLaunchValidationError';
import {
  assertDeterministicBootstrapPrimaryMemberLimit,
  assertOpenCodeNotLaunchedThroughLegacyProvisioning,
} from '../TeamProvisioningLaunchCompatibility';

describe('assertOpenCodeNotLaunchedThroughLegacyProvisioning', () => {
  it('accepts requests without any OpenCode participant', () => {
    expect(() =>
      assertOpenCodeNotLaunchedThroughLegacyProvisioning({
        providerId: 'anthropic',
        members: [{ providerId: 'codex' }],
      })
    ).not.toThrow();
  });

  it('rejects an OpenCode-led mixed team with a typed validation error', () => {
    const request = {
      providerId: 'opencode',
      members: [{ providerId: 'anthropic' }],
    };
    const run = () => assertOpenCodeNotLaunchedThroughLegacyProvisioning(request);
    expect(run).toThrow(TeamLaunchValidationError);
    expect(run).toThrow('Mixed teams with an OpenCode lead are not supported in this phase');
  });

  it('rejects a pure OpenCode legacy launch with a typed validation error', () => {
    const run = () =>
      assertOpenCodeNotLaunchedThroughLegacyProvisioning({
        providerId: 'opencode',
        members: [{ providerId: 'opencode' }],
      });
    expect(run).toThrow(TeamLaunchValidationError);
    expect(run).toThrow('legacy Claude stream-json provisioning path');
  });
});

describe('assertDeterministicBootstrapPrimaryMemberLimit', () => {
  it('accepts the documented maximum of primary teammates', () => {
    expect(() => assertDeterministicBootstrapPrimaryMemberLimit(30)).not.toThrow();
  });

  it('rejects a roster above the maximum with a typed validation error', () => {
    const run = () => assertDeterministicBootstrapPrimaryMemberLimit(31);
    expect(run).toThrow(TeamLaunchValidationError);
    expect(run).toThrow('supports up to 30 primary teammates; this team has 31');
  });
});
