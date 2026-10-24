import { z } from 'zod';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { launchPreparationFingerprint } from '../team-launch/launchPreparation.js';
import { applyLaunchConfiguration, launchConfigurationSchema } from './launchConfiguration.js';
import type { JsonValue } from '../contracts.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';

const id = z.string().min(1).max(256);
const scope = z.object({ launchId: id, rosterRevision: id }).strict();
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** Composition maps app configuration; the existing launch owner publishes it before opening. */
export function executeTeamLaunch(options: {
  launch: TeamLaunchOwner;
  entries: MemberEntry[];
  operation: 'start' | 'read' | 'retry' | 'configuration.read';
  members: readonly { memberId: string; name: string; role: 'lead' | 'member' }[];
  commandId: string;
  payload: unknown;
  beforeOpen?(): void;
}): JsonValue {
  const { launch, entries, operation, commandId } = options;
  if (operation === 'read' || operation === 'configuration.read') {
    z.object({}).strict().parse(options.payload);
    const summary = launch.read(); // Current Team read authority precedes any selected choices.
    if (operation === 'read') return json(summary);
    return json({
      launch: summary,
      members: summary.members.map(({ memberId }) => {
        const entry = entries.find((candidate) => candidate.profile.memberId === memberId);
        const configured = entry?.team.definition.members.find(
          (member) => member.memberId === memberId
        );
        const workspaceInherited =
          entry?.team.definition.savedSettings === undefined || !configured
            ? undefined
            : configured?.role === 'lead' || configured?.settings?.cwd === undefined;
        const selected = entry
          ? selectedLaunchConfiguration(entry.profile, workspaceInherited)
          : null;
        const member = options.members.find((member) => member.memberId === memberId);
        if (!member) throw new TeamLaunchError('conflict', 'launch-member');
        return {
          memberId,
          label: member.name,
          role: member.role,
          selected,
        };
      }),
    });
  }
  if (operation === 'retry') {
    const input = scope
      .extend({ attemptId: id, memberIds: z.array(id).min(1).max(256) })
      .strict()
      .parse(options.payload);
    return json(launch.retry({ ...input, commandId }));
  }
  const input = scope
    .extend({ configuration: launchConfigurationSchema.optional() })
    .strict()
    .parse(options.payload);
  const current = launch.read();
  let fingerprint: string | undefined;
  if (input.launchId !== current.launchId) throw new TeamLaunchError('conflict', 'launch-scope');
  if (input.configuration) {
    // Compile every requested member before publication: an incompatible option
    // on member N cannot leave a partially changed launch or allocate member1.
    const compiled = input.configuration.members.map(({ memberId, ...configuration }) => {
      const entry = entries.find((candidate) => candidate.profile.memberId === memberId);
      if (!entry) throw new TeamLaunchError('invalid', 'launch-member');
      const profile = applyLaunchConfiguration(entry.baseProfile, configuration);
      profile.generation = entry.profile.generation;
      return { entry, profile, configuration };
    });
    const preparation = {
      commandId,
      sourceRosterRevision: input.rosterRevision,
      members: compiled.map(({ entry, profile, configuration }) => ({
        memberId: profile.memberId,
        configuration: json(configuration),
        configurationDigest: runtimeDigest(profile),
        baseConfigurationDigest: runtimeDigest(entry.baseProfile),
        configRevision: profile.configRevision,
      })),
    };
    const created = launch.prepare(preparation);
    fingerprint = launchPreparationFingerprint(preparation);
    if (created)
      for (const { entry, profile, configuration } of compiled) {
        entry.profile = profile;
        entry.config = { ...entry.config, configRevision: profile.configRevision };
        entry.selection = {
          binding: entry.binding,
          generation: profile.generation,
          configurationDigest: runtimeDigest(profile),
          baseConfigurationDigest: runtimeDigest(entry.baseProfile),
          configuration: json(configuration),
        };
      }
  } else if (input.rosterRevision !== current.rosterRevision)
    throw new TeamLaunchError('conflict', 'launch-scope');
  return json(launch.start(commandId, fingerprint, options.beforeOpen));
}

export function selectedLaunchConfiguration(
  profile: RuntimeMemberProfile,
  workspaceInherited?: boolean
) {
  const permissions =
    profile.provider === 'claude'
      ? profile.nativeOptions?.permissionMode === 'bypassPermissions'
        ? 'bypass'
        : profile.nativeOptions?.permissionMode === 'default'
          ? 'manual'
          : undefined
      : profile.provider === 'codex'
        ? profile.nativeOptions.approvalPolicy === 'never' &&
          profile.nativeOptions.sandbox === 'danger-full-access'
          ? 'bypass'
          : profile.nativeOptions.approvalPolicy === 'on-request' &&
              profile.nativeOptions.sandbox === 'workspace-write'
            ? 'manual'
            : undefined
        : profile.nativeOptions.toolApprovalMode === 'auto'
          ? 'bypass'
          : profile.nativeOptions.toolApprovalMode === 'manual'
            ? 'manual'
            : undefined;
  const nativeEffort =
    profile.provider === 'codex'
      ? profile.nativeOptions.reasoningEffort
      : profile.provider === 'opencode'
        ? profile.nativeOptions.variant
        : undefined;
  return {
    provider: profile.provider,
    workspace: profile.cwd,
    ...(workspaceInherited === undefined ? {} : { workspaceInherited }),
    model: profile.model,
    capabilities:
      profile.provider === 'claude'
        ? ['model', 'effort', 'fastMode', 'permissions', 'context']
        : profile.provider === 'codex'
          ? ['model', 'effort', 'fastMode', 'permissions']
          : ['model', 'effort', 'permissions'],
    ...(profile.provider === 'claude'
      ? {
          ...(profile.nativeOptions?.effort === undefined
            ? {}
            : { effort: profile.nativeOptions.effort }),
          ...(profile.nativeOptions?.fastMode === undefined
            ? {}
            : { fastMode: profile.nativeOptions.fastMode }),
          ...(profile.nativeOptions?.context === undefined
            ? {}
            : { context: profile.nativeOptions.context }),
        }
      : {}),
    ...(nativeEffort === undefined ? {} : { effort: nativeEffort }),
    ...(profile.provider === 'codex' && profile.nativeOptions.fastMode !== undefined
      ? { fastMode: profile.nativeOptions.fastMode }
      : {}),
    ...(permissions === 'manual' || permissions === 'bypass' ? { permissions } : {}),
  };
}
