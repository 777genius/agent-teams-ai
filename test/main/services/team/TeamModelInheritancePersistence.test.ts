import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildMembersMetaWritePayload } from '@main/services/team/provisioning/TeamProvisioningConfigLaunchNormalization';
import { buildConfiguredMembersForPersistence } from '@main/services/team/provisioning/TeamProvisioningConfiguredMemberSpecs';
import { buildEffectiveTeamMemberSpecs } from '@main/services/team/provisioning/TeamProvisioningMemberSpecs';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

import type { TeamCreateRequest } from '@shared/types';

let testRoot: string | undefined;
afterEach(async () => {
  setClaudeBasePathOverride(null);
  if (testRoot) await fs.rm(testRoot, { recursive: true, force: true });
});

describe('configured member model persistence', () => {
  it.each([true, false])('retains intent through disk reopen, target edit and repeated lead changes (sync %s)', async (syncModelsWithLead) => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'model-inheritance-persistence-'));
    setClaudeBasePathOverride(testRoot);
    const model = 'zai-coding-plan/glm-5.3';
    const flash = 'zai-coding-plan/glm-5.3-flash';
    const request: TeamCreateRequest = {
      teamName: 'synthetic-inheritance', cwd: testRoot, providerId: 'opencode', model,
      syncModelsWithLead,
      members: [
        { name: 'inherit-one' }, { name: 'inherit-two' },
        { name: 'explicit-same', model }, { name: 'explicit-other', model: flash },
        { name: 'other-provider', providerId: 'codex' },
      ],
    };
    const runtime = buildEffectiveTeamMemberSpecs(request.members, request);
    const membersStore = new TeamMembersMetaStore();
    const teamStore = new TeamMetaStore();
    await fs.mkdir(path.join(testRoot, 'teams', request.teamName), { recursive: true });
    await teamStore.writeMeta(request.teamName, { ...request, createdAt: 1 });
    await membersStore.writeMembers(request.teamName, buildMembersMetaWritePayload(
      buildConfiguredMembersForPersistence(request.members, runtime)
    ));
    // Reopen through the actual public saved-request reader, with fresh store instances.
    const saved = await new TeamDataService().getSavedRequest(request.teamName);
    expect(saved).not.toBeNull();
    expect(saved!.members.find(member => member.name === 'inherit-two')?.model).toBeUndefined();
    expect(saved!.members.find(member => member.name === 'explicit-same')?.model).toBe(model);
    const configured = await new TeamMembersMetaStore().getMembers(request.teamName);
    const edited = configured.map(member => member.name === 'inherit-one' ? { ...member, model: flash } : member);
    // A discarded edit has no persistence effect.
    expect(await membersStore.getMembers(request.teamName)).toEqual(configured);
    await membersStore.writeMembers(request.teamName, edited);
    for (const leadModel of ['zai-coding-plan/glm-5.2', 'zai-coding-plan/glm-5.1']) {
      await teamStore.writeMeta(request.teamName, { ...request, model: leadModel, createdAt: 1 });
      const reopened = await new TeamDataService().getSavedRequest(request.teamName);
      const effective = buildEffectiveTeamMemberSpecs(reopened!.members, reopened!);
      const models = Object.fromEntries(effective.map(member => [member.name, member.model]));
      expect(models).toEqual({
        'inherit-one': flash, 'inherit-two': syncModelsWithLead ? leadModel : undefined,
        'explicit-same': model, 'explicit-other': flash, 'other-provider': undefined,
      });
      await membersStore.writeMembers(request.teamName, buildMembersMetaWritePayload(
        buildConfiguredMembersForPersistence(reopened!.members, effective)
      ));
    }
    expect((await membersStore.getMembers(request.teamName)).find(member => member.name === 'inherit-two')?.model)
      .toBeUndefined();
  });
});
