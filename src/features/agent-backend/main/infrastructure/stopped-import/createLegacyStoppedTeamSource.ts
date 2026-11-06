import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readImportBytes } from '@agent-teams/legacy-agent-host/stopped-team-import';
import { peekAutoResumeService } from '@main/services/team/AutoResumeService';
import {
  classifyLegacySavedTeamNativeRecords,
  isLegacySavedTeamProductRecords,
} from '@main/services/team/LegacySavedTeamNativeIdentity';
import { readLegacyNativeStopRelease } from '@main/services/team/provisioning/LegacyNativeStopRelease';
import { withTeamLaunchStatePublicationLock } from '@main/services/team/TeamLaunchStateStore';

import { rosterSettings } from '../../adapters/rosterValues';
import { captureConfiguredHostTeamDraft } from '../../application/createConfiguredHostTeam';

import type {
  SnapshotHeader,
  StoppedTeamSource,
} from '@agent-teams/legacy-agent-host/stopped-team-import';
import type { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';

export type LegacyStoppedImportReason =
  | 'source-changed'
  | 'owner-active'
  | 'command-unknown'
  | 'native-custody-unverified'
  | 'source-unreadable'
  | 'delivery-unknown';
export class LegacyStoppedImportHold extends Error {
  constructor(readonly reason: LegacyStoppedImportReason) {
    super(reason);
  }
}
export interface CapturedLegacyStoppedSource {
  sourceOwnerId: string;
  sourceId: string;
  contextId: string;
  teamName: string;
  /** Main captures actual service roots, never a renderer path. */
  roots: StoppedTeamSource['roots'];
  isCurrent(): boolean;
}
interface StoppedImportPublicationFacts {
  known: boolean;
  pending: number;
  revision: string;
}
/** Read capabilities required by this source; actual services remain composition-owned. */
export interface LegacyStoppedSourceOwners {
  backup: {
    withTeamIdentityFence<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
  };
  provisioning: {
    withStoppedTeamImportFence<T>(teamName: string, read: () => Promise<T>): Promise<T>;
    readStoppedTeamImportRuntimeFacts(teamName: string): Readonly<Record<string, number>>;
    readStoppedTeamImportLifecycleFacts(teamName: string): Readonly<Record<string, number>>;
    readStoppedTeamImportStopFacts(teamName: string): Readonly<Record<string, number>>;
    readStoppedTeamImportDeliveryFacts(teamName: string): Readonly<Record<string, number>>;
  };
  data: {
    readStoppedTeamImportBackgroundFacts(teamName: string): Readonly<Record<string, number>>;
    readStoppedTeamImportCommandFacts(teamName: string): Promise<StoppedImportPublicationFacts>;
    readStoppedTeamImportNotificationFacts(
      teamName: string
    ): Promise<StoppedImportPublicationFacts>;
  };
  launch: Pick<TeamLaunchStateStore, 'readResult'>;
}

const settings = [
  'cwd',
  'displayName',
  'description',
  'color',
  'prompt',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'syncModelsWithLead',
  'limitContext',
  'skipPermissions',
  'worktree',
  'extraCliArgs',
  'allowExperimentalLocalModels',
] as const;
const memberSettings = [
  'role',
  'workflow',
  'isolation',
  'cwd',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'mcpPolicy',
] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hold = (reason: LegacyStoppedImportReason): never => {
  throw new LegacyStoppedImportHold(reason);
};
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return hold('source-unreadable');
  return value as Record<string, unknown>;
}
function pick(source: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
  );
}
function privateConfiguration(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((item) => privateConfiguration(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (/^(env|environment|auth|credentials?|apiKey|accessToken|refreshToken|authorization|authToken|privateKey|account(?:Id|Config)?)$/i.test(
        key
      ) &&
        item !== null &&
        item !== undefined) ||
      privateConfiguration(item, depth + 1)
  );
}

/** Captured existing owners/fences only; missing cold custody evidence stays HOLD. */
export function createLegacyStoppedTeamSource(
  selected: CapturedLegacyStoppedSource,
  owners: LegacyStoppedSourceOwners
): StoppedTeamSource {
  const binding = { ...selected, roots: structuredClone(selected.roots) };
  const team = binding.roots.find((root) => root.category === 'team')?.path;
  if (!team || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(binding.teamName))
    return hold('source-unreadable');
  const current = () => {
    if (!binding.isCurrent()) hold('source-changed');
  };
  const read = (name: string) =>
    row(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          readImportBytes(join(team, name), 20 * 1024 * 1024)
        )
      )
    );
  return {
    roots: binding.roots,
    fenced: (capture) => {
      current();
      return owners.backup.withTeamIdentityFence(binding.teamName, () =>
        owners.provisioning.withStoppedTeamImportFence(binding.teamName, () =>
          withTeamLaunchStatePublicationLock(binding.teamName, capture)
        )
      );
    },
    async describe(): Promise<SnapshotHeader> {
      current();
      try {
        let config: Record<string, unknown> | null = null;
        try {
          config = read('config.json');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const meta = read('team.meta.json'),
          roster = read('members.meta.json');
        if ([config, meta, roster].some((value) => privateConfiguration(value)))
          return hold('source-unreadable');
        if (
          (config !== null && config.name !== binding.teamName) ||
          meta.version !== 1 ||
          roster.version !== 1 ||
          !Array.isArray(roster.members) ||
          (config !== null && !Array.isArray(config.members))
        )
          return hold('source-unreadable');
        const rosterMembers = roster.members.map(row);
        const members = rosterMembers.filter((member) => member.removedAt === undefined);
        // Actual save-only output has metadata/roster, but no CLI config or native lead.
        const configMembers = config ? (config.members as unknown[]).map(row) : [];
        const leads = config
          ? configMembers.filter((member) => member.agentType === 'team-lead')
          : [{ name: 'team-lead', ...pick(meta, memberSettings) }];
        if (leads.length !== 1 || typeof leads[0].name !== 'string')
          return hold('source-unreadable');
        const leadName = leads[0].name;
        const removedMembers = rosterMembers
          .filter((member) => member.removedAt !== undefined)
          .map((member) => {
            if (
              member.name === leadName ||
              typeof member.removedAt !== 'number' ||
              !Number.isFinite(member.removedAt) ||
              member.removedAt < 0
            )
              return hold('source-unreadable');
            return {
              memberId: member.name as string,
              name: member.name as string,
              role: 'member' as const,
              settings: rosterSettings(pick(member, memberSettings), false),
              removedAt: new Date(member.removedAt).toISOString(),
            };
          });
        if (config === null && members.some((member) => member.name === leadName))
          return hold('source-unreadable');
        const nonLead = members.filter((member) => member.name !== leadName);
        const draft = captureConfiguredHostTeamDraft(binding.contextId, {
          teamName: binding.teamName,
          ...pick(meta, settings),
          members: nonLead.map((member) => ({
            name: member.name,
            ...pick(member, memberSettings),
          })),
        });
        const lead = members.find((member) => member.name === leadName) ?? leads[0];
        const nativeIdentity = classifyLegacySavedTeamNativeRecords(binding.teamName, {
          config,
          meta,
          roster,
        });
        if (nativeIdentity === 'unknown') return hold('source-unreadable');
        if (
          nativeIdentity === 'empty' &&
          !isLegacySavedTeamProductRecords(binding.teamName, { config, meta, roster })
        )
          return hold('source-unreadable');
        const facts = {
          runtime: owners.provisioning.readStoppedTeamImportRuntimeFacts(binding.teamName),
          lifecycle: owners.provisioning.readStoppedTeamImportLifecycleFacts(binding.teamName),
          stop: owners.provisioning.readStoppedTeamImportStopFacts(binding.teamName),
          delivery: owners.provisioning.readStoppedTeamImportDeliveryFacts(binding.teamName),
          background: {
            ...owners.data.readStoppedTeamImportBackgroundFacts(binding.teamName),
            autoResume: Number(
              peekAutoResumeService()?.hasPendingForStoppedImport(binding.teamName) ?? false
            ),
          },
        };
        if (
          Object.values(facts).some((group) =>
            Object.values(group).some((count) => !Number.isSafeInteger(count) || count !== 0)
          )
        )
          return hold('owner-active');
        const notifications = await owners.data.readStoppedTeamImportNotificationFacts(
          binding.teamName
        );
        if (!notifications.known || notifications.pending) return hold('delivery-unknown');
        try {
          const outbox = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              readImportBytes(join(team, 'sent-cross-team.json'), 512 * 1024)
            )
          );
          if (!Array.isArray(outbox) || outbox.length) return hold('delivery-unknown');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return hold('delivery-unknown');
        }
        const command = await owners.data.readStoppedTeamImportCommandFacts(binding.teamName);
        if (!command.known || command.pending) return hold('command-unknown');
        const launch = await owners.launch.readResult(binding.teamName);
        // Exact original owner release is independent of stopped display or PID liveness.
        const nativeRelease = config ? readLegacyNativeStopRelease(team, binding.teamName) : null;
        if (
          launch.status !== 'absent' ||
          (!nativeRelease &&
            (nativeIdentity !== 'empty' ||
              readdirSync(team).some((name) =>
                /^(launch-|bootstrap-|stop-|runtime-|opencode-|\.opencode-runtime|\.member-work-sync|\.bootstrap)/.test(
                  name
                )
              )))
        )
          return hold('native-custody-unverified');
        const gaps: SnapshotHeader['gaps'] = [];
        for (const root of binding.roots) {
          try {
            const info = lstatSync(root.path);
            if (!info.isDirectory() || info.isSymbolicLink()) return hold('source-unreadable');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            gaps.push({ category: root.category, resourceId: 'root', reason: 'already-missing' });
          }
        }
        current();
        // Each release derives from the checked owner maps, strict command read and absent native census above.
        const released = 'released' as const;
        return {
          sourceOwnerId: binding.sourceOwnerId,
          sourceId: binding.sourceId,
          sourceTeamName: binding.teamName,
          sourceRevision: hash({
            config,
            meta,
            roster,
            facts,
            notifications,
            command,
            launch,
            nativeRelease,
          }),
          ...(config === null ? { sourceKind: 'saved-draft' as const } : {}),
          savedSettings: draft.savedSettings,
          members: [
            {
              memberId: leadName,
              name: leadName,
              role: 'lead',
              settings: rosterSettings(pick(lead, memberSettings), true),
            },
            ...draft.members.map((member) => ({
              memberId: member.name,
              name: member.name,
              role: 'member' as const,
              settings: member.memberSettings,
            })),
          ],
          ...(removedMembers.length ? { removedMembers } : {}),
          obligations: {
            launch: released,
            bootstrap: released,
            lane: released,
            session: released,
            stop: released,
            command: released,
            delivery: released,
            custody: released,
            background: released,
          },
          gaps,
        };
      } catch (error) {
        if (error instanceof LegacyStoppedImportHold) throw error;
        return hold('source-unreadable');
      }
    },
  };
}
