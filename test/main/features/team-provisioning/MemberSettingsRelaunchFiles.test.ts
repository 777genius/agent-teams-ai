import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));

import { prepareModelLaunchFixture } from './prepareModelLaunchFixture';

const sandbox = vi.hoisted(() => ({ root: '' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getTeamsBasePath: () => sandbox.root,
}));

import { applyMemberSettingsRelaunch, buildMemberSettingsRelaunchIntent, filterMemberSettingsRelaunchInputs } from '@features/team-provisioning/renderer/utils/memberSettingsRelaunch';
import { buildMembersFromDrafts, createMemberDraftsFromInputs } from '@renderer/components/team/members/membersEditorUtils';
import { executeTeamRelaunch } from '@renderer/components/team/dialogs/teamRelaunchFlow';
import { fingerprintSavedLaunchSettings } from '@features/team-provisioning/contracts';
import { persistDeterministicLaunchMetadata } from '@main/services/team/provisioning/TeamProvisioningLaunchDeterministicSpawnFlow';
import { buildLaunchSyntheticRequest } from '@main/services/team/provisioning/TeamProvisioningLaunchTeamFlow';
import { createMemberSettingsFingerprint } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import {
  createNodeLegacyMemberSettingsRepositoryDependencies,
  LegacyMemberSettingsRepositoryAdapter,
} from '@features/team-provisioning/main/adapters/output/LegacyMemberSettingsRepositoryAdapter';
import { persistNodeMemberSettingsRelaunch } from '@features/team-provisioning/main/composition/persistNodeMemberSettingsRelaunch';
import { resolveLaunchExpectedMembers } from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembers';
import { buildEffectiveTeamMemberSpecs } from '@main/services/team/provisioning/TeamProvisioningMemberSpecs';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

afterEach(async () => {
  if (sandbox.root) await rm(sandbox.root, { recursive: true, force: true });
});

describe('model relaunch file round trip', () => {
  it.each([
    { targetKind: 'member' as const, syntheticLead: false },
    { targetKind: 'lead' as const, syntheticLead: false },
    { targetKind: 'lead' as const, syntheticLead: true },
  ])(
    'reopens durable $targetKind intent (synthetic lead=$syntheticLead) for the next launch plan',
    async ({ targetKind, syntheticLead }) => {
      sandbox.root = await mkdtemp(join(tmpdir(), 'ariel-model-relaunch-'));
      const dir = join(sandbox.root, 'test-team');
      await mkdir(dir);
      const members = [
        { name: 'team-lead', agentType: 'team-lead', agentId: 'lead-1', model: 'glm-5.3' },
        { name: 'worker', agentType: 'general-purpose', agentId: 'worker-1', model: 'glm-5.3' },
        { name: 'inherited', agentType: 'general-purpose', agentId: 'sibling-1' },
      ];
      const persistedMembers = syntheticLead ? members.slice(1) : members;
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({ name: 'test-team', members: persistedMembers, custom: 'preserve' })
      );
      await new TeamMembersMetaStore().writeMembers('test-team', persistedMembers);
      await new TeamMetaStore().writeMeta('test-team', {
        cwd: sandbox.root,
        createdAt: 1,
        providerId: 'opencode',
        model: 'glm-5.3',
        syncModelsWithLead: true,
      });
      const dependencies = createNodeLegacyMemberSettingsRepositoryDependencies({
        isTeamAlive: () => false,
        invalidateWorkerCache: vi.fn(),
      });
      const repository = new LegacyMemberSettingsRepositoryAdapter(dependencies);
      const baseline = await Promise.all(
        members.map(async (member) => ({
          memberName: member.name,
          expectedFingerprint: createMemberSettingsFingerprint(
            (await repository.findTarget('test-team', member.name))!
          ),
        }))
      );
      const memberName = targetKind === 'lead' ? 'team-lead' : 'worker';
      const intent = {
        memberName,
        targetKind,
        expectedFingerprint: baseline.find((row) => row.memberName === memberName)!
          .expectedFingerprint,
        baseline,
        expectedTeamSettingsFingerprint: fingerprintSavedLaunchSettings(await new TeamMetaStore().getMeta('test-team')),
        model: 'glm-5.3-flash',
        effort: null,
      };
      const nextMembers = members
        .slice(1)
        .map((member) => ({
          ...member,
          ...(member.name === memberName ? { model: intent.model } : {}),
        }));
      await persistNodeMemberSettingsRelaunch('test-team', nextMembers, intent, {
        hasProvisioningRun: () => false,
        isTeamAlive: () => false,
        invalidateWorkerCache: vi.fn(),
      });

      const reopened = new LegacyMemberSettingsRepositoryAdapter(
        createNodeLegacyMemberSettingsRepositoryDependencies({
          isTeamAlive: () => false,
          invalidateWorkerCache: vi.fn(),
        })
      );
      expect((await reopened.findTarget('test-team', memberName))?.settings.model).toBe(
        'glm-5.3-flash'
      );
      const saved = (await new TeamMetaStore().getMeta('test-team'))!;
      expect(saved.model).toBe(targetKind === 'lead' ? 'glm-5.3-flash' : 'glm-5.3');
      const configRaw = await readFile(join(dir, 'config.json'), 'utf8');
      expect(JSON.parse(configRaw).custom).toBe('preserve');
      const resolution = await resolveLaunchExpectedMembers(
        { teamName: 'test-team', configRaw, leadProviderId: 'opencode' },
        {
          readLaunchState: async () => null,
          readBootstrapLaunchSnapshot: async () => null,
          getMeta: (name) => new TeamMembersMetaStore().getMeta(name),
          listInboxNames: async () => [],
          warn: vi.fn(),
        }
      );
      const effective = buildEffectiveTeamMemberSpecs(resolution.members, {
        providerId: saved.providerId,
        model: saved.model,
        syncModelsWithLead: saved.syncModelsWithLead,
      });
      const launchRequest = { teamName: 'test-team', cwd: sandbox.root, providerId: saved.providerId,
        model: saved.model, syncModelsWithLead: saved.syncModelsWithLead };
      await persistDeterministicLaunchMetadata({
        request: launchRequest,
        syntheticRequest: buildLaunchSyntheticRequest({ request: launchRequest, members: resolution.members, configRaw }),
        launchIdentity: null, allEffectiveMemberSpecs: effective, configuredMemberSpecs: resolution.members,
      }, { teamMetaStore: new TeamMetaStore(), membersMetaStore: new TeamMembersMetaStore(), nowMs: () => 2 });
      expect((await reopened.findTarget('test-team', 'inherited'))?.settings.model).toBeNull();
      expect(effective.find((member) => member.name === 'worker')?.model).toBe(
        targetKind === 'member' ? 'glm-5.3-flash' : 'glm-5.3'
      );
      expect(effective.find((member) => member.name === 'inherited')?.model).toBe(saved.model);
      expect(
        (await new TeamMembersMetaStore().getMeta('test-team'))?.members.find(
          (member) => member.name === 'inherited'
        )?.model
      ).toBeUndefined();
      const storedRoster = JSON.parse(await readFile(join(dir, 'members.meta.json'), 'utf8'));
      expect(
        storedRoster.members.find((member: { name: string }) => member.name === 'inherited')
      ).not.toHaveProperty('model');
    }
  );
});

it.each([false, true])('clears through settings trigger, real launch writer and next lead inheritance (legacy lead=%s)', async legacyLead => {
  sandbox.root = await mkdtemp(join(tmpdir(), 'ariel-model-relaunch-'));
  const teamName = 'test-team';
  const dir = join(sandbox.root, teamName);
  await mkdir(dir);
  const membersStore = new TeamMembersMetaStore();
  const teamStore = new TeamMetaStore();
  const lead = legacyLead ? { name: 'lead', role: 'Lead', model: 'lead-one' }
    : { name: 'team-lead', agentType: 'team-lead', model: 'lead-one' };
  const rows = [lead, { name: 'cleared', model: 'old-override' }, { name: 'inherited' },
    { name: 'explicit', providerId: 'codex' as const, providerBackendId: 'codex-native' as const,
      model: 'explicit-model', effort: 'high' as const, fastMode: 'off' as const }];
  await writeFile(join(dir, 'config.json'), JSON.stringify({ members: rows }));
  await membersStore.writeMembers(teamName, rows);
  await teamStore.writeMeta(teamName, { cwd: sandbox.root, providerId: 'anthropic', model: 'lead-one', effort: 'medium', syncModelsWithLead: true, createdAt: 1 });
  const options = { isTeamAlive: () => false, hasProvisioningRun: () => false, invalidateWorkerCache: vi.fn() };
  const repository = new LegacyMemberSettingsRepositoryAdapter(createNodeLegacyMemberSettingsRepositoryDependencies(options));
  const snapshots = await Promise.all(rows.map(row => repository.findTarget(teamName, row.name)));
  const projected = snapshots.map(snapshot => ({
    name: snapshot!.name, agentType: snapshot!.agentType ?? undefined,
    role: snapshot!.settings.role ?? undefined, model: 'runtime-observation',
    configuredRuntimeSettings: Object.fromEntries(Object.entries(snapshot!.settings).filter(([, value]) => value != null)),
    status: 'idle' as const, currentTaskId: null, taskCount: 0, messageCount: 0, lastActiveAt: null,
  }));
  const draft = {
    teamName, memberName: legacyLead ? 'lead' : 'cleared', targetKind: legacyLead ? 'lead' as const : 'member' as const,
    expectedFingerprint: createMemberSettingsFingerprint(snapshots[legacyLead ? 0 : 1]!),
    expectedTeamSettingsFingerprint: (await new TeamDataService().getSavedRequest(teamName))!.savedSettingsFingerprint!,
    settings: { ...snapshots[legacyLead ? 0 : 1]!.settings, model: legacyLead ? 'lead-two' : null },
  };
  const inputs = filterMemberSettingsRelaunchInputs(applyMemberSettingsRelaunch(projected, draft));
  expect(inputs.map(row => row.name)).toEqual(['cleared', 'inherited', 'explicit']);
  // The real dialog's member draft projection and submit builder.
  const submitted = buildMembersFromDrafts(createMemberDraftsFromInputs(inputs));
  const intent = buildMemberSettingsRelaunchIntent(draft, projected, draft.settings.model, null, submitted);
  const request = { teamName, cwd: sandbox.root, providerId: 'anthropic' as const, model: legacyLead ? 'lead-two' : 'lead-one', effort: 'medium' as const, syncModelsWithLead: true };
  const launch = async () => {
    const setup = await prepareModelLaunchFixture(request, sandbox.root);
    expect(setup.configuredMemberSpecs.map(row => row.name)).not.toContain('lead');
    // The actual setup's synthetic request is EFFECTIVE; only the separate configured
    // channel is allowed to write settings authority.
    expect(setup.syntheticRequest.members.find(row => row.name === 'inherited')?.model).toBe(request.model);
    await persistDeterministicLaunchMetadata({ request, ...setup },
      { teamMetaStore: teamStore, membersMetaStore: membersStore, nowMs: () => 2 });
    return setup.allEffectiveMemberSpecs;
  };
  await executeTeamRelaunch({ teamName, isTeamAlive: true, request, members: submitted, memberSettingsRelaunch: intent,
    stopTeam: vi.fn(), replaceMembers: (name, replacement) => persistNodeMemberSettingsRelaunch(name, replacement.members, replacement.memberSettingsRelaunch, options),
    launchTeam: launch,
  });
  const stored = JSON.parse(await readFile(join(dir, 'members.meta.json'), 'utf8'));
  for (const name of legacyLead ? ['inherited'] : ['cleared', 'inherited']) {
    const row = stored.members.find((row: { name: string }) => row.name === name);
    for (const key of ['model', 'effort', 'providerId', 'providerBackendId', 'fastMode']) expect(row).not.toHaveProperty(key);
    expect((await repository.findTarget(teamName, name))?.settings.model).toBeNull();
  }
  expect(stored.members.find((row: { name: string }) => row.name === 'explicit')).toMatchObject(rows[3]);
  // Change the lead default again after the real canonical write, then build AND write another launch.
  request.model = 'lead-three';
  await teamStore.updateMeta(teamName, current => ({ ...current!, model: request.model }));
  const next = await launch();
  expect(next.find(row => row.name === 'inherited')?.model).toBe('lead-three');
  if (!legacyLead) expect(next.find(row => row.name === 'cleared')?.model).toBe('lead-three');
  expect(next.find(row => row.name === 'explicit')?.model).toBe('explicit-model');
  expect((await repository.findTarget(teamName, 'inherited'))?.settings.model).toBeNull();
});
