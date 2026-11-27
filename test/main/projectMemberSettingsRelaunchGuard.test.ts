import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { fingerprintSavedLaunchSettings } from '@features/team-provisioning/contracts';
import { createMemberSettingsFingerprint } from '@features/team-provisioning/main';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertProjectMemberSettingsRelaunchBaseline } from '../../src/main/projectMemberSettingsRelaunchGuard';
import { TeamMetaStore } from '../../src/main/services/team/TeamMetaStore';
import { getTeamsBasePath, setClaudeBasePathOverride } from '../../src/main/utils/pathDecoder';

import type { MemberSettingsTarget, UpdateMemberSettingsRequest } from '@features/team-provisioning/contracts';

let root: string;
const settings = { role: null, workflow: null, isolation: null, providerId: null,
  providerBackendId: null, model: null, effort: null, fastMode: null, mcpPolicy: null } as const;
const lead: MemberSettingsTarget = { name: 'team-lead', agentType: 'team-lead', agentId: null, joinedAt: null, settings };
const alice: MemberSettingsTarget = { ...lead, name: 'alice', agentType: 'developer' };
let request: UpdateMemberSettingsRequest;
let members = [{ name: 'alice' }];
const ports = { data: () => ({ getSavedRequest: async () => ({ members }) }) } as never;
const targets = { getMemberSettingsTarget: async ({ memberName }: { memberName: string }) =>
  memberName === 'team-lead' ? lead : memberName === 'alice' ? alice : null } as never;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-relaunch-guard-'));
  setClaudeBasePathOverride(root);
  await fs.mkdir(path.join(getTeamsBasePath(), 'builders'), { recursive: true });
  const store = new TeamMetaStore();
  await store.writeMeta('builders', { cwd: '/p', createdAt: 1, projectContextMode: 'per_project' });
  const meta = await store.getMeta('builders');
  members = [{ name: 'alice' }];
  request = { commandId: 'one', idempotencyKey: 'one', teamName: 'builders', memberName: 'alice',
    expectedFingerprint: createMemberSettingsFingerprint(alice), targetKind: 'member', settings,
    relaunchGuard: { expectedTeamSettingsFingerprint: fingerprintSavedLaunchSettings(meta), baseline: [
      { memberName: 'team-lead', expectedFingerprint: createMemberSettingsFingerprint(lead) },
      { memberName: 'alice', expectedFingerprint: createMemberSettingsFingerprint(alice) },
    ] } };
});
afterEach(async () => {
  setClaudeBasePathOverride(null);
  await fs.rm(root, { recursive: true, force: true });
});

describe('project member settings relaunch baseline', () => {
  it('accepts an unchanged definition and refuses a changed roster or member', async () => {
    await expect(assertProjectMemberSettingsRelaunchBaseline(request, ports, targets)).resolves.toBeUndefined();
    members.push({ name: 'bob' });
    await expect(assertProjectMemberSettingsRelaunchBaseline(request, ports, targets)).rejects.toThrow(/roster changed/);
    members.pop();
    request.relaunchGuard!.baseline[1].expectedFingerprint = 'stale';
    await expect(assertProjectMemberSettingsRelaunchBaseline(request, ports, targets)).rejects.toThrow(/settings changed/);
  });

  it('accepts the actual retained lead name instead of inventing a team-lead row', async () => {
    const retained = { ...lead, name: 'lead', agentId: 'lead@builders', joinedAt: 7 };
    request.relaunchGuard!.baseline[0] = { memberName: 'lead', expectedFingerprint: createMemberSettingsFingerprint(retained) };
    const actualTargets = { getMemberSettingsTarget: async ({ memberName }: { memberName: string }) =>
      memberName === 'lead' ? retained : memberName === 'alice' ? alice : null } as never;
    await expect(assertProjectMemberSettingsRelaunchBaseline(request, ports, actualTargets)).resolves.toBeUndefined();
  });

  it('refuses changed team launch settings before any write', async () => {
    await new TeamMetaStore().updateMeta('builders', (meta) => ({ ...meta!, model: 'changed' }));
    await expect(assertProjectMemberSettingsRelaunchBaseline(request, ports, targets)).rejects.toThrow(/launch settings changed/);
  });
});
