import { runtimeDigest } from '../runtime/identity.js';
import { modelReadinessMechanismDigest, localModelReadinessCaptureSchema } from '../team-launch/launchReadiness.js';
import type { LocalModelReadinessCapture } from '../team-launch/launchReadiness.js';
import type { CreationModelReadinessTransfer } from './prepareTeamModelReadiness.js';
import { digest, effectId } from '../team/identity.js';
import { teamRosterRevision } from '../team/rosterSchema.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { captureReadinessPreparation, originalReadinessSubset } from '../adapters/providers/OpenCodeReadinessOrigin.js';
import type { LocalModelReadinessPreparation } from '../management/commandRecords.js';
import { ManagementCommandError } from '../management/commandRecords.js';
import { captureCreateTeamDraft } from './captureCreateTeamDraft.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamRegistry } from '../team-registry/TeamRegistry.js';
import type { RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type {
  CreateTeamLaunchCaptureResult,
  CreateTeamLaunchPreparationSnapshot,
  CreateTeamLaunchSubmitResult,
} from '../team-registry/createLaunchContracts.js';
import type { ProviderModelProbeSnapshot } from '../management/contracts.js';
import {
  createTeamLaunchCaptureResultSchema,
  createTeamLaunchPreparationInputSchema,
  createTeamLaunchSubmitResultSchema,
} from '../team-registry/createLaunchContracts.js';

/** Coordinates existing owners. Probe, registry, roster and launch retain their original journals. */
export class CreateTeamLaunchCoordinator {
  private readonly submitting = new Set<string>();

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

  private captureDraft(raw: unknown, validateWorkspace = true) {
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
    raw: unknown,
    origin?: LocalModelReadinessPreparation
  ): Promise<CreateTeamLaunchPreparationSnapshot> {
    if (action === 'cancel') return this.cancelPreparation(raw);
    const admittedAt = Date.now();
    const captured = this.captureDraft(raw);
    const { input, draftDigest } = captured;
    const anchorCommandId = this.probeCommand(input.preparationId, captured.selections[0]!.memberName);
    const original = this.options.management.probes.readPreparation(anchorCommandId);
    const prepared = action === 'start' && origin ? captureReadinessPreparation(origin, {
      kind: 'create', owner: this.options.profile.owner, contextId: input.draft.contextId,
      commandId: input.preparationId, selection: input, anchorCommandId, original, admittedAt,
      workspaces: captured.selections.filter(row => row.selection.profile.provider === 'opencode')
        .map(row => row.selection.profile.cwd),
      targets: captured.selections.filter(row => row.selection.profile.provider === 'opencode')
        .map(row => ({ workspace: row.selection.profile.cwd, providerId: row.selection.providerId })),
    }) : undefined;
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
          return this.captureDraft(raw).draftDigest === draftDigest;
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
        if (saved) saved = this.options.management.probes.startPrepared(originalInput, current);
        if (action === 'start' && !advanced && !saved) {
          // Earlier probes must be green before the next shared account fence can be admitted.
          if (probes.every((probe) => probe.ok)) {
            if (original.anchor && !prepared) throw new TeamLaunchError('hold', 'creation-origin-required');
            const origin = prepared && profile.provider === 'opencode'
              ? originalReadinessSubset(prepared.origin, profile.cwd, providerId) : undefined;
            const scope = profile.provider === 'opencode' ? {
              schemaVersion: 1 as const, kind: 'create' as const,
              actionDigest: runtimeDigest({ preparationId: input.preparationId, draftDigest }),
              selectionDigest: runtimeDigest(input), sourceRevision: draftDigest,
              rosterRevision: runtimeDigest(input.draft), mechanismDigest: modelReadinessMechanismDigest(profile),
              workspace: profile.cwd,
              cutoff: prepared?.anchor.expiresAt ?? admittedAt + (profile.modelProbeTimeoutMs ?? 90000),
              destinationKeys: captured.selections.filter(candidate => candidate.key === row.key)
                .map(candidate => runtimeDigest(candidate.memberName)),
            } : undefined;
            saved = this.options.management.probes.startPrepared(originalInput, current,
              prepared ? { anchor: prepared.anchor, ...(origin ? { origin } : {}) } : undefined, scope);
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
    return this.readOriginal(commandId, raw);
  }

  private readOriginal(commandId: string, raw: unknown, continueCapture = false): CreateTeamLaunchSubmitResult | null {
    this.options.assertCurrent();
    const input = createTeamLaunchPreparationInputSchema.parse(raw);
    if (!this.options.profile.creation?.contextIds.includes(input.draft.contextId))
      throw new TeamLaunchError('forbidden', 'creation-context');
    if (this.submitting.has(commandId)) throw new TeamLaunchError('hold', 'creation-pending');
    const creation = this.options.registry.lookup(commandId, input.draft.contextId, input.draft);
    if (!creation) return null;
    if (creation.phase !== 'published') throw new TeamLaunchError('hold', 'creation-pending');
    const team = this.options.team(creation.record.teamId);
    if (!team) throw new TeamLaunchError('hold', 'creation-team-unavailable');
    const ids = this.children(commandId);
    const registered = team.owner
      .runtimeCaptures(this.options.profile.principalId)
      .find((row) => row.commandId === ids.capture);
    if (!registered) {
      if (continueCapture) return null;
      throw new TeamLaunchError('hold', 'creation-capture-pending');
    }
    const result = this.options.runtime.readLaunchAdmission(
      creation.record.teamId,
      registered.launchId,
      ids.start
    );
    return { creation, ...result };
  }

  /** Original first submission only; actual cwd is returned before a changed-cwd Main capture. */
  async capture(commandId: string, raw: unknown, remainingMs: number): Promise<CreateTeamLaunchCaptureResult> {
    if (!Number.isSafeInteger(remainingMs) || remainingMs < 1 || remainingMs > 100000)
      throw new TeamLaunchError('invalid', 'creation-readiness-budget');
    const cutoff = Date.now() + remainingMs;
    const prior = this.readOriginal(commandId, raw, true), ids = this.children(commandId);
    if (prior) {
      // Repeated capture revokes the warm continuation; lookup alone remains read-only.
      await this.options.runtime.executeLaunch(prior.creation.record.teamId, 'capture', ids.capture,
        { rosterCommandId: ids.roster });
      return createTeamLaunchCaptureResultSchema.parse(prior);
    }
    const input = createTeamLaunchPreparationInputSchema.parse(raw);
    if (this.options.registry.lookup(commandId, input.draft.contextId, input.draft))
      throw new TeamLaunchError('hold', 'creation-capture-pending');
    this.submitting.add(commandId);
    try { return createTeamLaunchCaptureResultSchema.parse(await this.submitNew(commandId, raw, cutoff)); }
    finally { this.submitting.delete(commandId); }
  }

  async submit(commandId: string, raw: unknown, captured?: LocalModelReadinessCapture): Promise<CreateTeamLaunchSubmitResult> {
    if (captured) localModelReadinessCaptureSchema.parse(captured);
    const prior = this.readOriginal(commandId, raw, true);
    const ids = this.children(commandId);
    if (captured && (!prior || prior.launch.launchId !== captured.launchId ||
        prior.launch.rosterRevision !== captured.rosterRevision))
      throw new TeamLaunchError('conflict', 'creation-capture-changed');
    if (prior?.partialCreated && !captured) return prior;
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
    this.submitting.add(commandId);
    try {
      return await this.submitNew(commandId, raw);
    } finally {
      this.submitting.delete(commandId);
    }
  }

  private async submitNew(commandId: string, raw: unknown, captureCutoff?: number): Promise<CreateTeamLaunchSubmitResult> {
    const ids = this.children(commandId);
    const selected = this.captureDraft(raw),
      { input } = selected;
    const prepared = await this.prepare('read', input);
    if (!prepared.ready) throw new TeamLaunchError('conflict', 'creation-probe-required');
    if (captureCutoff !== undefined && Date.now() >= captureCutoff)
      throw new TeamLaunchError('hold', 'creation-readiness-expired');
    this.options.assertCurrent();
    if (
      selected.draftDigest !== prepared.draftDigest ||
      this.captureDraft(raw).draftDigest !== prepared.draftDigest
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
    const hasOpenCode = selected.selections.some(row => row.selection.profile.provider === 'opencode');
    const transfer: CreationModelReadinessTransfer | undefined = hasOpenCode ? {
      kind: 'create', input, draftDigest: selected.draftDigest,
      cutoff: Math.min(captureCutoff ?? Infinity, ...prepared.probes.map(row => row.expiresAt)),
      roster: { commandId: ids.roster, expected: payload },
      probes: selected.selections.filter(row => row.selection.profile.provider === 'opencode').map(row => {
        const first = selected.selections.find(candidate => candidate.key === row.key)!;
        return { memberName: row.memberName, commandId: this.probeCommand(input.preparationId, first.memberName),
          context: this.probeContext(input, first.memberName) };
      }),
    } : undefined;
    const captured = (await this.options.runtime.executeLaunch(
      creation.record.teamId,
      'capture',
      ids.capture,
      { rosterCommandId: ids.roster },
      transfer
    )) as { launch: { launchId: string; rosterRevision: string }; members: {
      memberId: string; label: string; selected: { provider: string; workspace: string } | null }[] };
    if (this.options.sources) {
      const actual = this.options.runtime.readLaunchSourceSelections?.(
        creation.record.teamId,
        captured.launch.launchId
      );
      if (!actual || digest(actual) !== digest(selected.sourceSelections))
        throw new TeamLaunchError('conflict', 'creation-source-changed');
    }
    const actualWorkspaceChanged = captured.members.some(member => member.selected?.provider === 'opencode' &&
      selected.selections.find(row => row.memberName === member.label)?.selection.profile.cwd !== member.selected.workspace);
    if (captureCutoff !== undefined || actualWorkspaceChanged)
      return createTeamLaunchCaptureResultSchema.parse({ creation,
        ...this.options.runtime.readLaunchAdmission(creation.record.teamId, captured.launch.launchId, ids.start) });
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
