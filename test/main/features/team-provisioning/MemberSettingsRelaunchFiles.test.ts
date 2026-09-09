import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const sandbox = vi.hoisted(() => ({ root: '' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getTeamsBasePath: () => sandbox.root,
}));

import { createMemberSettingsFingerprint } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import {
  createNodeLegacyMemberSettingsRepositoryDependencies,
  LegacyMemberSettingsRepositoryAdapter,
} from '@features/team-provisioning/main/adapters/output/LegacyMemberSettingsRepositoryAdapter';
import { persistNodeMemberSettingsRelaunch } from '@features/team-provisioning/main/composition/persistNodeMemberSettingsRelaunch';
import { resolveLaunchExpectedMembers } from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembers';
import { buildEffectiveTeamMemberSpecs } from '@main/services/team/provisioning/TeamProvisioningMemberSpecs';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
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
