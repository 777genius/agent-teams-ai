import { digest, effectId } from '../team/identity.js';
import { teamRosterRevision } from '../team/rosterSchema.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { captureCreateTeamDraft } from './captureCreateTeamDraft.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamRegistry } from '../team-registry/TeamRegistry.js';
import type { RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type {
  CreateTeamLaunchPreparationSnapshot,
  CreateTeamLaunchSubmitResult,
} from '../team-registry/createLaunchContracts.js';
import type { ProviderModelProbeSnapshot } from '../management/contracts.js';
import {
  createTeamLaunchPreparationInputSchema,
  createTeamLaunchSubmitResultSchema,
} from '../team-registry/createLaunchContracts.js';

/** Coordinates existing owners. Probe, registry, roster and launch retain their original journals. */
export class CreateTeamLaunchCoordinator {
  constructor(
    private readonly options: {
      profile: TeamHostProfile;
      registry: Pick<TeamRegistry, 'create' | 'lookup'>;
      runtime: Pick<RuntimeTeamCoordinator, 'executeLaunch' | 'readLaunchAdmission'>;
      management: Pick<ProviderManagementCoordinator, 'admitTeamProbeProfile' | 'probes'>;
      team(teamId: string): HostedTeam | undefined;
      assertCurrent(): void;
    }
  ) {}

  private capture(raw: unknown, validateWorkspace = true) {
    this.options.assertCurrent();
    return captureCreateTeamDraft(this.options.profile, raw, validateWorkspace);
  }

  async prepare(
    action: 'start' | 'read' | 'cancel',
    raw: unknown
  ): Promise<CreateTeamLaunchPreparationSnapshot> {
    const captured = this.capture(raw, action !== 'cancel');
    const { input, draftDigest } = captured;
    const groups = new Map<string, ProviderModelProbeSnapshot | null>();
    let advanced = false;
    const probes: CreateTeamLaunchPreparationSnapshot['probes'] = [];
    for (const row of captured.selections) {
      const first = captured.selections.find((candidate) => candidate.key === row.key)!;
      // Excluding the draft digest binds a reused preparation ID to its first original context.
      const commandId = effectId(
        'creation-probe',
        digest(this.options.profile.owner),
        input.preparationId,
        first.memberName
      );
      const { profile, providerId, model, effort, context } = row.selection;
      this.options.management.admitTeamProbeProfile(profile);
      const identity = {
        commandId,
        profileId: profile.profileId,
        configRevision: profile.configRevision,
      };
      const expected = digest({
        draftDigest,
        preparationId: input.preparationId,
        selection: row.selection,
      });
      const originalInput = {
        ...identity,
        providerId,
        modelId: model,
        context: expected,
        ...(effort === undefined ? {} : { effort }),
        ...(context === undefined ? {} : { modelContext: context }),
      };
      const current = () => {
        try {
          return this.capture(raw).draftDigest === draftDigest;
        } catch {
          return false;
        }
      };
      let saved = groups.get(row.key);
      if (saved === undefined) {
        saved = this.options.management.probes.read(identity);
        if (
          saved &&
          (saved.context !== expected ||
            saved.modelId !== model ||
            saved.effort !== effort ||
            saved.modelContext !== context)
        )
          throw new TeamLaunchError('conflict', 'creation-probe-selection');
        // Existing start replay validates the original target inode/account selection.
        // No await separates read and this same-ID replay under the single profile writer;
        // a query can never take the absent-intent allocation branch here.
        if (saved && action !== 'cancel')
          saved = this.options.management.probes.start(originalInput, current);
        if (action === 'cancel' && saved)
          saved = await this.options.management.probes.cancel(identity);
        if (action === 'start' && !advanced && !saved) {
          // Earlier probes must be green before the next shared account fence can be admitted.
          if (probes.every((probe) => probe.ok)) {
            saved = this.options.management.probes.start(originalInput, current);
            advanced = true;
          }
        }
        groups.set(row.key, saved);
      }
      probes.push({
        memberName: row.memberName,
        commandId,
        model,
        ...(effort === undefined ? {} : { effort }),
        ...(context === undefined ? {} : { context }),
        phase: saved?.phase ?? 'not-started',
        ok: !!saved?.ok && saved.phase === 'completed' && Date.now() < saved.expiresAt,
        expiresAt: saved?.expiresAt ?? 0,
      });
    }
    this.options.assertCurrent();
    return {
      preparationId: input.preparationId,
      draftDigest,
      ready: probes.every((probe) => probe.ok),
      probes,
    };
  }

  /** Read-only original admission, before considering renewal or a finite proof's expiry. */
  lookup(commandId: string, raw: unknown): CreateTeamLaunchSubmitResult | null {
    this.options.assertCurrent();
    const input = createTeamLaunchPreparationInputSchema.parse(raw);
    if (!this.options.profile.creation?.contextIds.includes(input.draft.contextId))
      throw new TeamLaunchError('forbidden', 'creation-context');
    const creation = this.options.registry.lookup(commandId, input.draft.contextId, input.draft);
    if (!creation) return null;
    if (creation.phase !== 'published') throw new TeamLaunchError('hold', 'creation-pending');
    const team = this.options.team(creation.record.teamId);
    if (!team) throw new TeamLaunchError('hold', 'creation-team-unavailable');
    const ids = this.children(commandId);
    const registered = team.owner
      .runtimeCaptures(this.options.profile.principalId)
      .find((row) => row.commandId === ids.capture);
    if (!registered) return null;
    const launch = this.options.runtime.readLaunchAdmission(
      creation.record.teamId,
      registered.launchId,
      ids.start
    );
    return launch ? { creation, launch } : null;
  }

  async submit(commandId: string, raw: unknown): Promise<CreateTeamLaunchSubmitResult> {
    const prior = this.lookup(commandId, raw);
    const ids = this.children(commandId);
    if (prior) {
      // Resume the same admitted prompt/start command only; claimed native attempts cannot open twice.
      const launch = await this.options.runtime.executeLaunch(
        prior.creation.record.teamId,
        'start',
        ids.start,
        {
          launchId: prior.launch.launchId,
          rosterRevision: prior.launch.rosterRevision,
        }
      );
      return createTeamLaunchSubmitResultSchema.parse({
        creation: prior.creation,
        launch,
      });
    }
    const { input } = this.capture(raw);
    const prepared = await this.prepare('read', input);
    if (!prepared.ready) throw new TeamLaunchError('conflict', 'creation-probe-required');
    this.options.assertCurrent();
    const creation = this.options.registry.create(commandId, input.draft);
    if (creation.phase !== 'published') throw new TeamLaunchError('hold', 'creation-pending');
    const team = this.options.team(creation.record.teamId);
    if (!team) throw new TeamLaunchError('hold', 'creation-team-unavailable');
    const initialMembers = creation.record.members.map((member, index) => ({
      memberId: member.memberId,
      name: member.label,
      role: index === 0 ? ('lead' as const) : ('member' as const),
      ...(index === 0 ? {} : { settings: input.draft.members[index - 1]!.memberSettings }),
    }));
    const expectedRevision = teamRosterRevision(initialMembers, 0, input.draft.savedSettings);
    const payload = {
      expectedRevision,
      savedSettings: input.draft.savedSettings,
      members: input.draft.members.map(({ name, memberSettings }) => ({
        name,
        ...memberSettings,
      })),
    };
    const original = team.connection.lookupRoster(ids.roster, payload);
    if (!original) {
      if (team.connection.readRoster().revision !== expectedRevision)
        throw new TeamLaunchError('conflict', 'creation-roster-changed');
      team.connection.replaceRoster({ ...payload, commandId: ids.roster });
    }
    const captured = (await this.options.runtime.executeLaunch(
      creation.record.teamId,
      'capture',
      ids.capture,
      { rosterCommandId: ids.roster }
    )) as { launch: { launchId: string; rosterRevision: string } };
    const launch = await this.options.runtime.executeLaunch(creation.record.teamId, 'start', ids.start, {
      launchId: captured.launch.launchId,
      rosterRevision: captured.launch.rosterRevision,
    });
    return createTeamLaunchSubmitResultSchema.parse({ creation, launch });
  }

  private children(commandId: string) {
    // Match registry's durable identity; Host build/revision changes must not mint another launch.
    const owner = digest({
      ownerId: this.options.profile.owner.ownerId,
      profileId: this.options.profile.owner.profileId,
      principalId: this.options.profile.principalId,
    });
    return {
      roster: effectId('creation-roster', owner, commandId),
      capture: effectId('creation-capture', owner, commandId),
      start: effectId('creation-start', owner, commandId),
    };
  }
}
