import { describe, expect, it } from 'vitest';

import { track } from './builderTestContext';
import {
  assertNoSecretLikeFixtureValues,
  collectSecretLikeFixtureValues,
  HARNESS_DEFAULT_NOW_ISO,
  makeLaunchState,
  makeOpenCodeEvidence,
  makeProvisioningRun,
  makeRuntimeSnapshot,
  makeTeamCreateRequest,
  memberFixture,
  teamConfigFixture,
  teamMetaFixture,
  TeamProvisioningHarnessBuilder,
  toMetaMembers,
} from './index';

import type { TeamCreateRequest, TeamMember, ToolApprovalRequest } from '@shared/types';

describe('TeamProvisioningHarnessBuilder fixture isolation', () => {
  it('clones domain fixture inputs so caller mutation cannot leak between fake snapshots', () => {
    const members = [memberFixture.lead(), memberFixture.codex('Original')];
    const config = teamConfigFixture.basic({ teamName: 'alias-fixture-team', members });
    members[1]!.name = 'Mutated input';
    members.push(memberFixture.codex('Added later'));
    expect(config.members?.map((member) => member.name)).toEqual(['Lead', 'Original']);

    const request = makeTeamCreateRequest({ teamName: 'alias-run-team', members });
    const run = makeProvisioningRun({ request });
    request.members[1]!.name = 'Mutated request';
    run.request.members[1]!.name = 'Mutated run request';
    expect(run.effectiveMembers.map((member) => member.name)).toEqual([
      'Mutated input',
      'Added later',
    ]);
    expect(run.allEffectiveMembers.map((member) => member.name)).toEqual([
      'Mutated input',
      'Added later',
    ]);

    const runtimeMembers = {
      Worker: {
        memberName: 'Worker',
        alive: true,
        restartable: true,
        updatedAt: HARNESS_DEFAULT_NOW_ISO,
      },
    };
    const runtimeSnapshot = makeRuntimeSnapshot({ members: runtimeMembers });
    runtimeMembers.Worker.alive = false;
    expect(runtimeSnapshot.members.Worker?.alive).toBe(true);

    const diagnostics = ['runtime-ready'];
    const evidence = makeOpenCodeEvidence({ diagnostics });
    diagnostics.push('mutated');
    expect(evidence.diagnostics).toEqual(['runtime-ready']);

    const approval: ToolApprovalRequest = {
      requestId: 'approval-1',
      runId: 'harness-run-id',
      teamName: 'map-isolation-team',
      source: 'lead',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/harness-fixture.txt' },
      receivedAt: HARNESS_DEFAULT_NOW_ISO,
    };
    const pendingApprovals = new Map([['approval-1', approval]]);
    const runWithMapOverride = makeProvisioningRun({
      overrides: { pendingApprovals },
    });
    pendingApprovals.get('approval-1')!.toolName = 'MutatedTool';
    expect(runWithMapOverride.pendingApprovals.get('approval-1')?.toolName).toBe('Read');
  });

  it('keeps mutable fixture defaults isolated across calls', () => {
    const firstConfig = teamConfigFixture.basic();
    const secondConfig = teamConfigFixture.basic();
    firstConfig.members![1]!.name = 'Mutated default config';
    expect(secondConfig.members?.map((member) => member.name)).toEqual(['Lead', 'Builder']);

    const firstRequest = makeTeamCreateRequest();
    const secondRequest = makeTeamCreateRequest();
    firstRequest.members[0]!.name = 'Mutated default request';
    expect(secondRequest.members.map((member) => member.name)).toEqual(['Builder']);

    const firstRuntime = makeRuntimeSnapshot();
    const secondRuntime = makeRuntimeSnapshot();
    firstRuntime.members.Builder!.alive = false;
    expect(secondRuntime.members.Builder?.alive).toBe(true);
  });

  it('does not mutate caller-owned launch-state members while filling expected defaults', () => {
    const members = {
      Existing: {
        name: 'Existing',
        launchState: 'confirmed_alive' as const,
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        lastEvaluatedAt: HARNESS_DEFAULT_NOW_ISO,
        diagnostics: [],
      },
    };

    const snapshot = makeLaunchState({
      expectedMembers: ['Builder'],
      members,
    });

    expect(snapshot.members).toHaveProperty('Builder');
    expect(members).toEqual({
      Existing: expect.objectContaining({ name: 'Existing' }),
    });
    expect(members).not.toHaveProperty('Builder');
  });

  it('does not leak confirmed runtime defaults into non-confirmed OpenCode evidence', () => {
    const failedEvidence = makeOpenCodeEvidence({ launchState: 'failed_to_start' });

    expect(failedEvidence).toMatchObject({
      launchState: 'failed_to_start',
      agentToolAccepted: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: true,
      livenessKind: 'registered_only',
    });
    expect(failedEvidence).not.toHaveProperty('sessionId');
    expect(failedEvidence).not.toHaveProperty('runtimePid');
    expect(failedEvidence).not.toHaveProperty('bootstrapEvidenceSource');
    expect(failedEvidence).not.toHaveProperty('pidSource');

    const pendingEvidence = makeOpenCodeEvidence({ launchState: 'runtime_pending_bootstrap' });
    expect(pendingEvidence).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      livenessKind: 'runtime_process_candidate',
      pidSource: 'opencode_bridge',
    });
    expect(pendingEvidence).not.toHaveProperty('bootstrapEvidenceSource');
  });

  it('normalizes lead topology, teammate agent types, and provider/backend pairs', () => {
    const lead = memberFixture.lead({
      name: 'ignored-lead-override',
      agentType: 'general-purpose',
      providerBackendId: 'adapter',
    });
    const builder = memberFixture.codex('Builder', {
      agentType: 'orchestrator',
      providerBackendId: 'adapter',
    });
    const reviewer: TeamMember = {
      name: 'Reviewer',
      providerId: 'anthropic',
      providerBackendId: 'codex-native',
    };
    const config = teamConfigFixture.basic({
      members: [
        lead,
        { name: 'Duplicate Lead', agentType: 'lead', providerId: 'opencode' },
        builder,
        reviewer,
      ],
    });

    expect(lead).toMatchObject({
      name: 'Lead',
      agentType: 'team-lead',
      providerBackendId: 'codex-native',
    });
    expect(builder).toMatchObject({
      agentType: 'general-purpose',
      providerBackendId: 'codex-native',
    });
    expect(config.members).toEqual([
      expect.objectContaining({ name: 'Lead', agentType: 'team-lead' }),
      expect.objectContaining({
        name: 'Builder',
        agentType: 'general-purpose',
        providerBackendId: 'codex-native',
      }),
      expect.objectContaining({
        name: 'Reviewer',
        agentType: 'general-purpose',
        providerBackendId: undefined,
      }),
    ]);

    const request = makeTeamCreateRequest({
      providerId: 'anthropic',
      providerBackendId: 'opencode-cli',
      members: [
        memberFixture.lead(),
        { name: 'Hidden Lead', agentType: 'orchestrator', providerId: 'opencode' },
        builder,
      ],
    });
    expect(request).toMatchObject({
      providerId: 'anthropic',
      providerBackendId: undefined,
      members: [expect.objectContaining({ name: 'Builder', providerBackendId: 'codex-native' })],
    });
    expect(toMetaMembers(request.members)).toEqual([
      expect.objectContaining({ name: 'Builder', agentType: 'general-purpose' }),
    ]);
  });

  it('re-normalizes final provisioning run overrides against effective topology', () => {
    const impossibleRequest = {
      ...makeTeamCreateRequest({ teamName: 'wrong-team' }),
      providerId: 'codex',
      providerBackendId: 'opencode-cli',
      members: [
        { name: 'team-lead', providerId: 'codex', providerBackendId: 'adapter' },
        { name: 'Runtime', providerId: 'opencode', providerBackendId: 'codex-native' },
      ],
    } as TeamCreateRequest;
    const run = makeProvisioningRun({
      teamName: 'override-run-team',
      overrides: {
        request: impossibleRequest,
        allEffectiveMembers: [
          { name: 'team-lead', providerId: 'codex', providerBackendId: 'adapter' },
          { name: 'Runtime', providerId: 'opencode', providerBackendId: 'codex-native' },
          { name: 'Archive', providerId: 'anthropic', providerBackendId: 'adapter' },
        ],
        effectiveMembers: [
          { name: 'team-lead', providerId: 'codex', providerBackendId: 'adapter' },
          { name: 'Runtime', providerId: 'opencode', providerBackendId: 'codex-native' },
        ],
        expectedMembers: ['team-lead', 'Ghost', 'Runtime', 'Runtime'],
      },
    });

    expect(run.request).toMatchObject({
      teamName: 'override-run-team',
      providerId: 'codex',
      providerBackendId: undefined,
      members: [expect.objectContaining({ name: 'Runtime', providerBackendId: undefined })],
    });
    expect(run.allEffectiveMembers).toEqual([
      expect.objectContaining({ name: 'Runtime', providerBackendId: undefined }),
      expect.objectContaining({ name: 'Archive', providerBackendId: undefined }),
    ]);
    expect(run.effectiveMembers).toEqual([
      expect.objectContaining({ name: 'Runtime', providerBackendId: undefined }),
    ]);
    expect(run.expectedMembers).toEqual(['Runtime']);
  });

  it('returns fresh fake store snapshots after callers mutate prior reads', async () => {
    const teamName = 'fake-snapshot-isolation-team';
    const launchState = { teamName, nested: { state: 'ready' } };
    const bootstrapState = { teamName, nested: { checkpoint: 'runtime-ready' } };
    const runtimeStore = { teamName, sessions: [{ memberName: 'Builder', alive: true }] };
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTeam(teamName)
        .withTeamMeta(teamName, teamMetaFixture.basic({ displayName: 'Snapshot Team' }))
        .withLaunchState(teamName, launchState)
        .withBootstrapState(teamName, bootstrapState)
        .withRuntimeStore(teamName, runtimeStore)
        .build()
    );

    const firstConfig = await harness.stores.configReader.getConfigSnapshot(teamName);
    firstConfig!.members![0]!.name = 'Mutated config read';
    await expect(harness.stores.configReader.getConfigSnapshot(teamName)).resolves.toMatchObject({
      members: expect.arrayContaining([expect.objectContaining({ name: 'Lead' })]),
    });

    const firstTeamMeta = await harness.stores.teamMetaStore.getMeta(teamName);
    firstTeamMeta!.displayName = 'Mutated meta read';
    await expect(harness.stores.teamMetaStore.getMeta(teamName)).resolves.toMatchObject({
      displayName: 'Snapshot Team',
    });

    const firstMembersMeta = await harness.stores.membersMetaStore.getMeta(teamName);
    firstMembersMeta!.members[0]!.name = 'Mutated members meta read';
    await expect(harness.stores.membersMetaStore.getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ name: 'Builder' }),
    ]);

    const firstLaunch = (await harness.stores.launchStateStore.read(
      teamName
    )) as typeof launchState;
    firstLaunch.nested.state = 'mutated';
    await expect(harness.stores.launchStateStore.read(teamName)).resolves.toEqual(launchState);

    const firstBootstrap = (await harness.stores.bootstrapStateStore.read(
      teamName
    )) as typeof bootstrapState;
    firstBootstrap.nested.checkpoint = 'mutated';
    await expect(harness.stores.bootstrapStateStore.read(teamName)).resolves.toEqual(
      bootstrapState
    );

    const firstRuntime = (await harness.stores.runtimeStore.read(teamName)) as typeof runtimeStore;
    firstRuntime.sessions[0]!.alive = false;
    await expect(harness.stores.runtimeStore.read(teamName)).resolves.toEqual(runtimeStore);
  });

  it('keeps built-in fixture values secret-free and exposes a failing scanner for bad keys', () => {
    const sampleFixtures = {
      members: [
        memberFixture.lead(),
        memberFixture.codex('builder'),
        memberFixture.anthropic('reviewer'),
        memberFixture.opencode('runtime'),
      ],
      config: teamConfigFixture.basic({
        teamName: 'secret-free-team',
        members: [memberFixture.lead(), memberFixture.codex('builder')],
      }),
      meta: teamMetaFixture.basic({ displayName: 'Secret Free Team' }),
    };

    expect(collectSecretLikeFixtureValues(sampleFixtures)).toEqual([]);
    expect(() => assertNoSecretLikeFixtureValues(sampleFixtures)).not.toThrow();
    const keyFinding = collectSecretLikeFixtureValues({ apiKey: 'fixture' });
    expect(keyFinding).toEqual([
      expect.objectContaining({ path: '$[key#0:redacted]', patternName: 'secret-like-key' }),
    ]);
    expect(keyFinding[0]?.path).not.toContain('apiKey');

    const nestedKeyFinding = collectSecretLikeFixtureValues({
      nested: { authToken: 'fixture' },
    });
    expect(nestedKeyFinding).toEqual([
      expect.objectContaining({
        path: '$[key#0:safe][key#0:redacted]',
        patternName: 'secret-like-key',
      }),
    ]);
    expect(nestedKeyFinding[0]?.path).not.toContain('nested');
    expect(nestedKeyFinding[0]?.path).not.toContain('authToken');
    expect(collectSecretLikeFixtureValues({ value: 'Bearer [defanged fixture]' })).toEqual([]);
    expect(collectSecretLikeFixtureValues({ value: `Bearer ${'fixtureToken'.repeat(2)}` })).toEqual(
      [
        expect.objectContaining({
          path: '$[key#0:safe]',
          patternName: 'bearer-token',
          stringLength: 31,
          redactedValue: '<redacted>',
        }),
      ]
    );
    expect(
      collectSecretLikeFixtureValues(new Set([`Bearer ${'setFixtureToken'.repeat(2)}`]))
    ).toEqual([
      expect.objectContaining({
        path: '$[setValue#0]',
        patternName: 'bearer-token',
        redactedValue: '<redacted>',
      }),
    ]);
    expect(() =>
      assertNoSecretLikeFixtureValues({ member: { password: 'fixture-placeholder' } })
    ).toThrow(/Secret-like fixture values/);
  });

  it('does not include secret-like raw object keys in scanner findings or thrown errors', () => {
    const rawSecretKey = `Bearer ${'fixtureKey'.repeat(2)}`;
    const nestedSecretKey = 'authToken';
    const matchedValue = `Bearer ${'fixtureToken'.repeat(2)}`;
    const fixture = {
      [rawSecretKey]: {
        [nestedSecretKey]: matchedValue,
      },
    };

    const findings = collectSecretLikeFixtureValues(fixture);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.path).not.toContain(rawSecretKey);
      expect(finding.path).not.toContain(nestedSecretKey);
      expect(finding.reason).not.toContain(rawSecretKey);
      expect(finding.reason).not.toContain(nestedSecretKey);
    }
    expect(findings.map((finding) => finding.path)).toEqual(
      expect.arrayContaining(['$[key#0:redacted]', '$[key#0:redacted][key#0:redacted]'])
    );

    let thrown: unknown;
    try {
      assertNoSecretLikeFixtureValues(fixture);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain(rawSecretKey);
    expect(message).not.toContain(nestedSecretKey);
    expect(message).not.toContain(matchedValue);
    expect(message).toContain('<redacted>');
  });

  it('does not include matched secret-like raw values in thrown scanner errors', () => {
    const matchedValue = `Bearer ${'fixtureToken'.repeat(2)}`;

    let thrown: unknown;
    try {
      assertNoSecretLikeFixtureValues({ value: matchedValue });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain(matchedValue);
    expect(message).toContain('<redacted>');
    expect(message).toContain('length=31');
  });
});
