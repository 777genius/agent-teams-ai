import { resolveLaunchExpectedMembers } from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembers';
import { afterEach, describe, expect, it } from 'vitest';

import {
  memberFixture,
  teamConfigFixture,
  type TeamProvisioningHarness,
  TeamProvisioningHarnessBuilder,
} from './provisioningHarness';

const harnesses: TeamProvisioningHarness[] = [];

async function track(
  harnessPromise: Promise<TeamProvisioningHarness>
): Promise<TeamProvisioningHarness> {
  const harness = await harnessPromise;
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) {
    await harness.cleanup();
  }
});

describe('team provisioning launch expected members harness', () => {
  it('resolves members.meta through harness-backed extracted service ports', async () => {
    const teamName = 'launch-expected-members-meta-team';
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ applyPathOverride: false })
        .withTeam(
          teamName,
          teamConfigFixture.basic({
            teamName,
            members: [
              memberFixture.lead(),
              memberFixture.codex('ConfigOnly'),
              memberFixture.codex('Builder', { role: 'Config Builder' }),
            ],
          })
        )
        .withMembersMeta(teamName, [
          memberFixture.codex('Builder', {
            role: 'Runtime Builder',
            workflow: 'Use harness metadata',
          }),
          memberFixture.codex('Builder-2', { role: 'Filtered duplicate' }),
        ])
        .withInbox(teamName, 'InboxOnly')
        .withLaunchState(teamName, { teamName, marker: 'launch-state-read' })
        .withBootstrapState(teamName, { teamName, marker: 'bootstrap-state-read' })
        .build()
    );
    const configRaw = await harness.stores.configReader.readTeamConfigRaw(teamName);

    const result = await resolveLaunchExpectedMembers(
      {
        teamName,
        configRaw: configRaw ?? '{}',
        leadProviderId: 'codex',
      },
      harness.facades.launchExpectedMembersPorts
    );

    expect(result.source).toBe('members-meta');
    expect(result.members).toEqual([
      expect.objectContaining({
        name: 'Builder',
        role: 'Runtime Builder',
        workflow: 'Use harness metadata',
      }),
    ]);
  });

  it('falls back to harness inbox fixtures and preserves config member metadata', async () => {
    const teamName = 'launch-expected-inbox-team';
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ applyPathOverride: false })
        .withTeam(
          teamName,
          teamConfigFixture.basic({
            teamName,
            members: [
              memberFixture.lead(),
              memberFixture.codex('Reviewer', {
                role: 'Review Engineer',
                workflow: 'Check diffs',
              }),
            ],
          })
        )
        .withMembersMeta(teamName, [])
        .withInbox(teamName, 'team-lead')
        .withInbox(teamName, 'Reviewer')
        .withInbox(teamName, 'user')
        .build()
    );
    const configRaw = await harness.stores.configReader.readTeamConfigRaw(teamName);

    const result = await resolveLaunchExpectedMembers(
      {
        teamName,
        configRaw: configRaw ?? '{}',
        leadProviderId: 'codex',
      },
      harness.facades.launchExpectedMembersPorts
    );

    expect(result.source).toBe('inboxes');
    expect(result.members).toEqual([
      expect.objectContaining({
        name: 'Reviewer',
        role: 'Review Engineer',
        workflow: 'Check diffs',
      }),
    ]);
  });
});
