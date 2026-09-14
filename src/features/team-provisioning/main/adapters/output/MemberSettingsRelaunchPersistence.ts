import { fromProvisioningMembers } from '@features/team-runtime-lanes';
import { applyLeadRuntimeSettingsToTeamMeta } from '@main/services/team/provisioning/TeamProvisioningLeadRuntimeRestart';

import { fingerprintSavedLaunchSettings } from '../../../contracts/savedLaunchSettings';
import {
  createMemberSettingsFingerprint,
  isCanonicalLeadTarget,
} from '../../../core/domain/memberSettingsPolicy';

import { LegacyMemberSettingsRepositoryAdapter } from './LegacyMemberSettingsRepositoryAdapter';

import type { EditableMemberSettings } from '../../../contracts/memberSettings';
import type { LegacyMemberSettingsRepositoryDependencies } from './LegacyMemberSettingsRepositoryAdapter';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type { ReplaceMembersRequest } from '@shared/types';

/** Commit configured relaunch intent under the existing config mutation lock. */
export async function persistMemberSettingsRelaunch(
  teamName: string,
  request: ReplaceMembersRequest,
  dependencies: LegacyMemberSettingsRepositoryDependencies & {
    hasProvisioningRun(teamName: string): boolean | Promise<boolean>;
  },
  teamMetaStore: Pick<TeamMetaStore, 'getMeta' | 'updateMeta'>
): Promise<void> {
  const intent = request.memberSettingsRelaunch;
  if (!intent) throw new Error('Missing member settings relaunch intent');
  await dependencies.withConfigLock(teamName, async () => {
    if (await dependencies.isTeamAlive(teamName) || await dependencies.hasProvisioningRun(teamName))
      throw new Error('Stop the team before saving relaunch settings');
    const previousTeamMeta = await teamMetaStore.getMeta(teamName);
    if (fingerprintSavedLaunchSettings(previousTeamMeta) !== intent.expectedTeamSettingsFingerprint)
      throw new Error('Team launch settings changed. Reopen member settings.');
    // The outer lock covers validation, every target write and rollback.
    const repository = new LegacyMemberSettingsRepositoryAdapter({
      ...dependencies,
      withConfigLock: async (_name, operation) => operation(),
    });
    const snapshots = await Promise.all(
      intent.baseline.map((row) => repository.findTarget(teamName, row.memberName))
    );
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index];
      if (
        !snapshot ||
        createMemberSettingsFingerprint(snapshot) !== intent.baseline[index].expectedFingerprint
      ) {
        throw new Error('Team settings changed. Reopen member settings.');
      }
    }
    const target = snapshots.find((snapshot) => snapshot?.name === intent.memberName);
    if (
      !target ||
      createMemberSettingsFingerprint(target) !== intent.expectedFingerprint ||
      isCanonicalLeadTarget(target) !== (intent.targetKind === 'lead')
    ) {
      throw new Error('Member settings changed. Reopen member settings.');
    }
    const plan = fromProvisioningMembers(target.leadProviderId ?? undefined, request.members);
    if (!plan.ok) throw new Error(plan.message);
    const meta = await dependencies.membersMetaStore.getMeta(teamName);
    const rawConfig = await dependencies.readConfigJson(teamName);
    const configMembers = rawConfig
      ? (JSON.parse(rawConfig) as { members?: { name: string; removedAt?: number }[] }).members ?? []
      : [];
    const persisted = [...(meta?.members ?? []), ...configMembers];
    const removed = new Set(persisted.filter(row => row.removedAt != null).map(row => row.name));
    const activeNames = [...new Set([
      ...persisted.filter(row => !removed.has(row.name)).map(row => row.name),
      // The existing repository synthesizes the lead from saved launch defaults.
      ...snapshots.filter(row => row && isCanonicalLeadTarget(row)).map(row => row!.name),
    ])].sort();
    const baselineNames = intent.baseline.map((row) => row.memberName).sort();
    if (JSON.stringify(activeNames) !== JSON.stringify(baselineNames)) {
      throw new Error('Team roster changed. Reopen member settings.');
    }
    const memberNames = snapshots
      .filter((row) => row && !isCanonicalLeadTarget(row))
      .map((row) => row!.name)
      .sort();
    if (
      JSON.stringify(request.members.map((row) => row.name).sort()) !== JSON.stringify(memberNames)
    ) {
      throw new Error('Save member settings before changing the team roster.');
    }
    if (intent.targetKind === 'lead' && !previousTeamMeta) throw new Error('Team metadata missing');
    const applied: {
      previous: NonNullable<typeof target>;
      fingerprint: string;
      rollbackToken: unknown;
    }[] = [];
    try {
      for (const previous of snapshots) {
        if (!previous) continue;
        const member = request.members.find((row) => row.name === previous.name);
        const settings: EditableMemberSettings = member
          ? {
              role: member.role ?? null,
              workflow: member.workflow ?? null,
              isolation: member.isolation ?? null,
              providerId: member.providerId ?? null,
              providerBackendId: member.providerBackendId ?? null,
              model: member.model ?? null,
              effort: member.effort ?? null,
              fastMode: member.fastMode ?? null,
              mcpPolicy: member.mcpPolicy ?? null,
            }
          : previous.settings;
        const next =
          previous.name === intent.memberName && intent.targetKind === 'lead'
            ? { ...settings, model: intent.model, effort: intent.effort }
            : settings;
        if (JSON.stringify(next) === JSON.stringify(previous.settings)) continue;
        const result = await repository.applyTarget({
          teamName,
          memberName: previous.name,
          expectedFingerprint: createMemberSettingsFingerprint(previous),
          settings: next,
        });
        if (result.outcome !== 'applied')
          throw new Error('Member settings changed during relaunch');
        applied.push({
          previous,
          fingerprint: createMemberSettingsFingerprint(result.snapshot),
          rollbackToken: result.rollbackToken,
        });
      }
      if (intent.targetKind === 'lead' && previousTeamMeta) {
        await teamMetaStore.updateMeta(teamName, (current) => {
          if (
            !current ||
            fingerprintSavedLaunchSettings(current) !== fingerprintSavedLaunchSettings(previousTeamMeta)
          ) {
            throw new Error('Team launch settings changed during relaunch');
          }
          return applyLeadRuntimeSettingsToTeamMeta(
            current,
            { model: intent.model, effort: intent.effort },
            null
          );
        });
      }
    } catch (error) {
      const failures: unknown[] = [];
      for (const saved of applied.reverse()) {
        try {
          const restored = await repository.restoreTarget({
            teamName,
            memberName: saved.previous.name,
            expectedFingerprint: saved.fingerprint,
            snapshot: saved.previous,
            rollbackToken: saved.rollbackToken,
          });
          if (!restored) failures.push(new Error('Member rollback conflict'));
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length)
        throw new AggregateError([error, ...failures], 'Relaunch persistence recovery required');
      throw error;
    }
    dependencies.invalidateCaches(teamName);
  });
}
