import { digest, effectId } from '../team/identity.js';
import { teamRosterRevision } from '../team/rosterSchema.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { captureCreateTeamDraft } from './captureCreateTeamDraft.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
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
      sources?: RuntimeRecipeSources;
      registry: Pick<TeamRegistry, 'create' | 'lookup'>;
      runtime: Pick<RuntimeTeamCoordinator, 'executeLaunch' | 'readLaunchAdmission'> &
        Partial<Pick<RuntimeTeamCoordinator, 'readLaunchSourceSelections'>>;
      management: Pick<ProviderManagementCoordinator, 'admitTeamProbeProfile' | 'probes'>;
      team(teamId: string): HostedTeam | undefined;
      assertCurrent(): void;
    }
  ) {}

  private capture(raw: unknown, validateWorkspace = true) {
    this.options.assertCurrent();
    return captureCreateTeamDraft(
      this.options.profile,
      raw,
      validateWorkspace,
      this.options.sources
    );
  }

  async prepare(
    action: 'start' | 'read' | 'cancel',
    raw: unknown
  ): Promise<CreateTeamLaunchPreparationSnapshot> {
    if (action === 'cancel') return this.cancelPreparation(raw);
    const captured = this.capture(raw);
    const { input, draftDigest } = captured;
    const groups = new Map<string, ProviderModelProbeSnapshot | null>();
    let advanced = false;
    const probes: CreateTeamLaunchPreparationSnapshot['probes'] = [];
    for (const row of captured.selections) {
      const first = captured.selections.find((candidate) => candidate.key === row.key)!;
      // Excluding the draft digest binds a reused preparation ID to its first original context.
      const commandId = this.probeCommand(input.preparationId, first.memberName);
      const { profile, providerId, model, effort, context } = row.selection;
      this.options.management.admitTeamProbeProfile(profile);
      const identity = {
        commandId,
        profileId: profile.profileId,
        configRevision: profile.configRevision,
      };
      const expected = this.probeContext(input, first.memberName);
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
          ((saved.context !== expected &&
            saved.context !== this.legacyProbeContext(input, first.memberName)) ||
            saved.modelId !== model ||
            saved.effort !== effort ||
            saved.modelContext !== context)
        )
          throw new TeamLaunchError('conflict', 'creation-probe-selection');
        if (saved?.context) originalInput.context = saved.context;
        // Existing start replay validates the original target inode/account selection.
        // No await separates read and this same-ID replay under the single profile writer;
        // a query can never take the absent-intent allocation branch here.
        if (saved) saved = this.options.management.probes.start(originalInput, current);
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

  private probeCommand(preparationId: string, memberName: string): string {
    return effectId(
      'creation-probe',
      digest(this.options.profile.owner),
      preparationId,
      memberName
    );
  }

  /** Cleanup authority follows original product intent; selection remains bound by the probe fingerprint/target. */
  private probeContext(
    input: ReturnType<typeof createTeamLaunchPreparationInputSchema.parse>,
    memberName: string
  ): string {
    return digest({
      owner: this.options.profile.owner,
      principalId: this.options.profile.principalId,
      preparationId: input.preparationId,
      draft: input.draft,
      memberName,
    });
  }

  private legacyProbeContext(
    input: ReturnType<typeof createTeamLaunchPreparationInputSchema.parse>,
    memberName: string
  ): string {
    const seed = captureCreateTeamDraft(this.options.profile, input, false);
    const row = seed.selections.find((value) => value.memberName === memberName);
    if (!row) throw new TeamLaunchError('conflict', 'creation-probe-selection');
    return digest({
      draftDigest: seed.draftDigest,
      preparationId: input.preparationId,
      selection: row.selection,
    });
  }

  private async cancelPreparation(raw: unknown): Promise<CreateTeamLaunchPreparationSnapshot> {
    this.options.assertCurrent();
    const input = createTeamLaunchPreparationInputSchema.parse(raw);
    if (!this.options.profile.creation?.contextIds.includes(input.draft.contextId))
      throw new TeamLaunchError('forbidden', 'creation-context');
    const probes: CreateTeamLaunchPreparationSnapshot['probes'] = [];
    const members = [
      { name: 'team-lead', model: input.draft.savedSettings.model },
      ...input.draft.members.map((member) => ({
        name: member.name,
        model: member.memberSettings.model,
      })),
    ];
    for (const member of members) {
      const commandId = this.probeCommand(input.preparationId, member.name);
      let context = this.probeContext(input, member.name),
        saved;
      try {
        saved = this.options.management.probes.readContextual(commandId, context);
      } catch (error) {
        if (!(error instanceof ManagementCommandError) || error.code !== 'conflict') throw error;
        context = this.legacyProbeContext(input, member.name);
        saved = this.options.management.probes.readContextual(commandId, context);
      }
      if (saved) saved = await this.options.management.probes.cancelContextual(commandId, context);
      probes.push({
        memberName: member.name,
        commandId,
        model: saved?.modelId ?? member.model ?? '__provider_default__',
        ...(saved?.effort === undefined ? {} : { effort: saved.effort }),
        ...(saved?.modelContext === undefined ? {} : { context: saved.modelContext }),
        phase: saved?.phase ?? 'not-started',
        ok: false,
        expiresAt: saved?.expiresAt ?? 0,
      });
    }
    this.options.assertCurrent();
    return {
      preparationId: input.preparationId,
      draftDigest: digest({
        owner: this.options.profile.owner,
        principalId: this.options.profile.principalId,
        draft: input.draft,
        templates: this.options.profile.runtime?.providerTemplates ?? [],
      }),
      ready: false,
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
    const selected = this.capture(raw),
      { input } = selected;
    const prepared = await this.prepare('read', input);
    if (!prepared.ready) throw new TeamLaunchError('conflict', 'creation-probe-required');
    this.options.assertCurrent();
    if (
      selected.draftDigest !== prepared.draftDigest ||
      this.capture(raw).draftDigest !== prepared.draftDigest
    )
      throw new TeamLaunchError('conflict', 'creation-source-changed');
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
    if (this.options.sources) {
      const actual = this.options.runtime.readLaunchSourceSelections?.(
        creation.record.teamId,
        captured.launch.launchId
      );
      if (!actual || digest(actual) !== digest(selected.sourceSelections))
        throw new TeamLaunchError('conflict', 'creation-source-changed');
    }
    const launch = await this.options.runtime.executeLaunch(
      creation.record.teamId,
      'start',
      ids.start,
      {
        launchId: captured.launch.launchId,
        rosterRevision: captured.launch.rosterRevision,
      }
    );
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
