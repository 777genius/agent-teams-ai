import {
  assertDeterministicBootstrapPrimaryMemberLimit,
  assertOpenCodeNotLaunchedThroughLegacyProvisioning,
  buildLargeDeterministicBootstrapWarning,
  getMixedLaunchFallbackRecoveryError,
  getOpenCodeMixedProviderProvisioningError,
  isPureOpenCodeProvisioningRequest,
  mergeProvisioningWarnings,
} from '@main/services/team/provisioning/TeamProvisioningLaunchCompatibility';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningLaunchCompatibility', () => {
  it('classifies pure OpenCode legacy provisioning requests', () => {
    expect(
      isPureOpenCodeProvisioningRequest({
        providerId: 'opencode',
        members: [{ providerId: 'opencode' }, {}],
      })
    ).toBe(true);

    expect(
      isPureOpenCodeProvisioningRequest({
        providerId: 'codex',
        members: [{ providerId: 'opencode' }],
      })
    ).toBe(false);
  });

  it('blocks pure OpenCode legacy stream-json launch but allows supported side-lane mixed teams', () => {
    expect(() =>
      assertOpenCodeNotLaunchedThroughLegacyProvisioning({
        providerId: 'opencode',
        members: [{ providerId: 'opencode' }],
      })
    ).toThrow('OpenCode team launch is not enabled in the legacy Claude stream-json provisioning path');

    expect(() =>
      assertOpenCodeNotLaunchedThroughLegacyProvisioning({
        providerId: 'codex',
        members: [{ providerId: 'opencode' }, { providerId: 'codex' }],
      })
    ).not.toThrow();
  });

  it('keeps unsupported OpenCode-led mixed teams blocked with planner diagnostics', () => {
    expect(() =>
      assertOpenCodeNotLaunchedThroughLegacyProvisioning({
        providerId: 'opencode',
        members: [{ providerId: 'anthropic' }, { providerId: 'opencode' }],
      })
    ).toThrow('Mixed teams with an OpenCode lead are not supported');
  });

  it('deduplicates provisioning warnings while preserving latest ordering', () => {
    expect(mergeProvisioningWarnings(undefined, null)).toBeUndefined();
    expect(mergeProvisioningWarnings(['alpha', 'beta'], 'alpha')).toEqual(['beta', 'alpha']);
    expect(mergeProvisioningWarnings(['alpha'], 'beta')).toEqual(['alpha', 'beta']);
  });

  it('bounds deterministic bootstrap team size warnings and hard limits', () => {
    expect(buildLargeDeterministicBootstrapWarning(8)).toBeNull();
    expect(buildLargeDeterministicBootstrapWarning(9)).toContain('Large Codex team launch: 9');
    expect(() => assertDeterministicBootstrapPrimaryMemberLimit(30)).not.toThrow();
    expect(() => assertDeterministicBootstrapPrimaryMemberLimit(31)).toThrow(
      'supports up to 30 primary teammates'
    );
  });

  it('keeps user-facing compatibility error copy stable', () => {
    expect(getOpenCodeMixedProviderProvisioningError()).toContain(
      'outside the current support scope'
    );
    expect(getMixedLaunchFallbackRecoveryError()).toContain('missing stable member metadata');
  });
});
