import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { settledRuntimeInput } from '../runtime/settledRuntimeInput.js';
import { validateLaunchRecord } from '../team-launch/validateLaunchRecord.js';
import { validateMemberSelectionChain } from '../team-launch/memberActions.js';
import { validateNativeLaunchAdditions } from '../team-launch/nativeLaunchAddition.js';
import { createMemberEntry } from './createMemberEntry.js';
import { restoreNativeRuntimeEntries, validateRetainedNativeRuntimeEntries } from './restoreNativeRuntimeEntries.js';
import { RuntimeSourceUnavailable } from './runtimeSourceGrantAuthority.js';
import { effectId } from '../team/identity.js';
import { prepareWorktreeLaunch } from '../team-launch/worktreePreparation.js';
import { prepareCapturedRuntimeMcpRecipes } from './capturedRuntimeMcpRecipes.js';
import { captureRuntimeSourceProcessOrigin } from './captureRuntimeProcessOrigin.js';
import {
  hasRuntimeWorktrees,
  runtimeWorktreeGit,
  planRuntimeWorktrees,
  materializeRuntimeWorktrees,
} from './runtimeWorktreeCapture.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import {
  capturedTeam,
  captureRuntimeSource,
  compileRuntimeCapture,
  runtimeCaptureSourceSchema,
  validateRuntimeCaptureMcpArtifacts,
  runtimeCaptureRegistration,
  runtimeCaptureBaseRecipes,
  runtimeCaptureRecipeCandidates,
  captureRuntimeRecipeSources,
} from './runtimeCaptureSource.js';
import type { HostedTeam } from './MemberEntry.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import type { TeamLaunchRecord } from '../team-launch/contracts.js';
import type { TeamRuntimeCapture } from '../team/runtimeRegistrationContracts.js';
import type { HostWindowsLaunch } from '../owned-process/HostWindowsLaunch.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
export const captureTeamRuntimeSchema = z.object({ rosterCommandId: id }).strict();

/** Reuses Team's registration receipt and the existing immutable launch record; no native effects. */
export class RuntimeTeamCaptures {
  private readonly unavailable = new Map<string, readonly TeamRuntimeCapture[]>();
  private prepared = false;
  constructor(
    private readonly options: {
      profile: TeamHostProfile;
      sources?: RuntimeRecipeSources;
      retainedWindowsLaunch?: HostWindowsLaunch;
      teams: ReadonlyMap<string, HostedTeam>;
      assertCurrent(): void;
      readRuntimeSiblings(binding: RuntimeBinding): RuntimeSessionRecord[];
      install(
        team: HostedTeam,
        profiles: RuntimeMemberProfile[],
        mode: 'prepare' | 'retain' | 'activate'
      ): void;
    }
  ) {}

  /** Validate every original reference before any seed or retained entry enters a runnable map. */
  prepareRestore(): void {
    if (this.prepared) return;
    for (const team of this.options.teams.values()) {
      const teamId = team.definition.binding.teamId;
      if (!needsRuntimeRestore(this.options.profile, team)) continue;
      const registrations = team.owner.runtimeCaptures(this.options.profile.principalId);
      const sourceRows = registrations.map(registration => ({
        registration, source: this.source(team, registration),
      }));
      const seedRecord = this.record(this.store(team), team.definition.scope.runId);
      this.assertRecordScope(team, seedRecord);
      validateRetainedNativeRuntimeEntries(this.options.profile, team);
      for (const row of sourceRows)
        validateRetainedNativeRuntimeEntries(this.options.profile, capturedTeam(team, row.source, row.registration));
      try {
        const seeds = this.options.profile.runtime?.members.filter(row => row.teamId === teamId) ?? [];
        if (seedRecord?.definition.members.some(member => member.configurationDigest !== null &&
            !seedRecord.nativeAdditions?.some(row => row.member.memberId === member.memberId) &&
            !seeds.some(seed => seed.memberId === member.memberId)))
          throw new RuntimeSourceUnavailable();
        this.preflightEntries(team, seeds, seedRecord);
        for (const row of sourceRows) {
          const compiled = compileRuntimeCapture(this.options.profile, team, row.source, 'restore', this.options.sources);
          this.preflightEntries(capturedTeam(team, row.source, row.registration), compiled.profiles,
            this.record(this.store(team), row.registration.launchId));
        }
      } catch (error) {
        if (!(error instanceof RuntimeSourceUnavailable)) throw error;
        this.unavailable.set(teamId, structuredClone(registrations));
      }
    }
    this.prepared = true;
  }

  private preflightEntries(team: HostedTeam, profiles: RuntimeMemberProfile[], record?: TeamLaunchRecord): void {
    const projected = { ...team, definition: structuredClone(team.definition) };
    const entries = profiles.map(baseProfile => createMemberEntry({
      root: this.options.profile.owner.storageRoot, ownerId: this.options.profile.owner.ownerId,
      team: projected, baseProfile, restoring: true,
    }));
    for (const entry of entries) {
      const expected = record?.definition.members.find(member => member.memberId === entry.profile.memberId);
      if (expected && expected.configurationDigest !== runtimeDigest(entry.profile))
        throw new RuntimeSourceUnavailable();
    }
    const registry = new Map(entries.map(entry => [runtimeDigest(normalizeBinding(entry.binding)), entry]));
    restoreNativeRuntimeEntries({ profile: this.options.profile, team: projected, entries, registry, restoring: true });
  }

  available(teamId: string): boolean {
    return !this.unavailable.has(teamId);
  }

  assertAvailable(teamId: string): void {
    if (!this.available(teamId)) throw new RuntimeOwnerError('hold');
  }

  restore(): void {
    this.prepareRestore();
    for (const team of this.options.teams.values()) {
      if (!this.available(team.definition.binding.teamId) ||
          !needsRuntimeRestore(this.options.profile, team)) continue;
      const selected = team.owner.runtimeCapture(this.options.profile.principalId);
      for (const registration of team.owner.runtimeCaptures(this.options.profile.principalId))
        this.restoreCapture(team, registration, selected?.launchId === registration.launchId ||
          (!selected && this.nativeSuccessor(team, registration)));
    }
  }

  /** Read original debt only. A missing profile never grants cleanup or creates an empty Runtime record. */
  assertUnavailableReleased(): void {
    for (const [teamId, registrations] of this.unavailable) {
      const team = this.options.teams.get(teamId)!;
      const store = this.store(team);
      const original = new Map<string, { binding: RuntimeBinding; absentAllowed: boolean }>();
      const retain = (binding: RuntimeBinding | null | undefined, absentAllowed: boolean) => {
        if (!binding) return;
        const value = normalizeBinding(binding);
        if (value.backendId !== team.definition.binding.backendId || value.teamId !== teamId)
          throw new RuntimeOwnerError('hold');
        const key = runtimeDigest(value), previous = original.get(key);
        original.set(key, { binding: value, absentAllowed: absentAllowed && (previous?.absentAllowed ?? true) });
      };
      const inspect = (record: TeamLaunchRecord | undefined, bindings: readonly RuntimeBinding[]) => {
        const settled = record && !record.memberActions?.some(row => !['selected', 'refused'].includes(row.phase)) &&
          !record.resumePreparations?.some(row => row.members.some(member => !member.refused &&
            !record.restorations?.some(selected => selected.commandId === member.commandId))) &&
          (!record.worktreePreparation || record.worktreePreparation.completedSourceDigest !== undefined);
        if (record && !settled) throw new RuntimeOwnerError('hold');
        const unclaimed = !!record && !!settled && record.startCommandId === undefined &&
          record.startedAtMs === undefined && record.preparation === undefined &&
          record.members.every(member => member.attempts.every(attempt => attempt.claimed === false));
        for (const binding of bindings) retain(binding, unclaimed);
        for (const member of [
          ...(record?.definition.members ?? []),
          ...(record?.memberActions?.flatMap(row => [row.source, row.selected]) ?? []),
          ...(record?.restorations?.map(row => row.member) ?? []),
          ...(record?.nativeAdditions?.map(row => row.member) ?? []),
        ]) {
          retain(member.binding, unclaimed);
          retain(member.restore?.sourceBinding, false);
        }
      };
      const seedRecord = this.record(store, team.definition.scope.runId);
      this.assertRecordScope(team, seedRecord);
      inspect(seedRecord, team.definition.members.flatMap(member =>
        member.delivery && !registrations.some(row => row.launchId === member.delivery!.runId)
          ? [normalizeBinding(member.delivery)] : []));
      for (const registration of registrations) {
        this.source(team, registration); // Recheck the original registration/source, never a current seed.
        inspect(this.record(store, registration.launchId), registration.members.map(member => normalizeBinding(member.delivery)));
      }
      const checked = new Map<string, RuntimeSessionRecord[]>();
      for (const { binding, absentAllowed } of original.values()) {
        const key = runtimeDigest({ backendId: binding.backendId, teamId: binding.teamId, memberId: binding.memberId });
        let siblings = checked.get(key);
        if (!siblings) {
          siblings = this.options.readRuntimeSiblings(binding);
          for (const row of siblings)
            if (row.phase !== 'closed' || row.custody !== 'released' || row.control ||
                row.inputs.some(input => !settledRuntimeInput(input)) ||
                row.interactions.some(item => item.phase !== 'resolved') ||
                row.checkpoints?.some(checkpoint => checkpoint.status === 'capturing'))
              throw new RuntimeOwnerError('hold');
          checked.set(key, siblings);
        }
        if (!siblings.some(row => runtimeDigest(normalizeBinding(row.binding)) === runtimeDigest(binding)) && !absentAllowed)
          throw new RuntimeOwnerError('hold');
      }
    }
  }

  async capture(teamId: string, commandId: string, raw: unknown): Promise<string> {
    id.parse(commandId);
    const input = captureTeamRuntimeSchema.parse(raw),
      team = this.options.teams.get(teamId);
    if (!team) throw new TeamLaunchError('invalid', 'team');
    this.assertAvailable(teamId);
    const operator = this.options.profile.principalId;
    team.owner.withLaunchAuthority(operator, 'control', () => undefined);
    const prior = team.owner.runtimeCaptures(operator).find((row) => row.commandId === commandId);
    if (prior) {
      const source = this.source(team, prior);
      if (source.rosterCommandId !== input.rosterCommandId)
        throw new TeamLaunchError('conflict', 'capture-command');
      // Registration replay rechecks current admin authority and the exact original payload.
      const compiled = compileRuntimeCapture(this.options.profile, team, source, 'launch', this.options.sources);
      team.owner.registerRuntime(operator, compiled.registration);
      this.restoreCapture(
        team,
        prior,
        team.owner.runtimeCapture(operator)?.launchId === prior.launchId || this.nativeSuccessor(team, prior)
      );
      return prior.launchId;
    }
    const saved = team.connection.lookupRoster(input.rosterCommandId);
    const roster = team.connection.readRoster();
    if (!saved || saved.revision !== roster.revision)
      throw new TeamLaunchError('conflict', 'capture-source-revision');
    const store = this.store(team),
      launchId = effectId('team-launch', teamId, commandId);
    const original = this.record(store, launchId);
    let intent = original
      ? runtimeCaptureSourceSchema.parse(
          original.worktreePreparation?.intent ?? original.definition.capture
        )
      : captureRuntimeSource(this.options.profile, team, commandId, input.rosterCommandId, roster, {
          deferMcp: true,
          ...(this.options.sources ? { sources: this.options.sources } : {}),
        });
    if (
      intent.commandId !== commandId ||
      intent.rosterCommandId !== input.rosterCommandId ||
      intent.configurationRevision !== roster.revision
    )
      throw new TeamLaunchError('conflict', 'capture-source-revision');
    const expectedAdmission =
      original?.worktreePreparation?.admission ??
      team.owner.assertRuntimeRegistration(operator, runtimeCaptureRegistration(team, intent));
    const assertCurrent = () => {
      this.options.assertCurrent();
      this.assertAvailable(teamId);
      if (!original && runtimeDigest(intent.recipeSources ?? []) !== runtimeDigest(
        captureRuntimeRecipeSources(this.options.profile, team, roster, this.options.sources)))
        throw new TeamLaunchError('hold', 'capture-source-selection-changed');
      if (
        team.connection.readRoster().revision !== intent.configurationRevision ||
        team.owner.assertRuntimeRegistration(operator, runtimeCaptureRegistration(team, intent)) !==
          expectedAdmission
      )
        throw new TeamLaunchError('hold', 'capture-authority-changed');
      // Initial intent binds original templates/accounts/options; final MCP reads wait for the actual cwd.
      compileRuntimeCapture(this.options.profile, team, intent, 'model-preflight', this.options.sources);
    };
    assertCurrent();
    const finalizeSource = async (
      context: NonNullable<Parameters<typeof captureRuntimeSource>[5]> = {}
    ) => {
      const prepared = { ...intent, ...context };
      const selection = this.options.sources ? { sources: this.options.sources, scope: team.definition.scope } : undefined;
      const baseRecipes = runtimeCaptureBaseRecipes(this.options.profile, teamId, prepared, selection);
      const selectedRecipes = runtimeCaptureRecipeCandidates(this.options.profile, teamId, {
        ...prepared,
        mcpCaptureVersion: 1,
      }, selection);
      const mcpRecipeReferences = await prepareCapturedRuntimeMcpRecipes({
        store,
        commandId,
        baseRecipes,
        selectedRecipes,
        assertCurrent,
        processOrigin: member => captureRuntimeSourceProcessOrigin(this.options.profile,
          team.definition.scope, teamId, intent, member, this.options.sources),
        ...(this.options.retainedWindowsLaunch ? { retainedWindowsLaunch: this.options.retainedWindowsLaunch } : {}),
        withAuthority: (action) =>
          team.owner.withLaunchAuthority(operator, 'control', () => {
            assertCurrent();
            return action();
          }),
      });
      assertCurrent();
      return captureRuntimeSource(
        this.options.profile,
        team,
        commandId,
        input.rosterCommandId,
        roster,
        { ...context, mcpRecipeReferences, sourceReferences: intent.recipeSources ?? [],
          ...(this.options.sources ? { sources: this.options.sources } : {}) }
      );
    };
    let source;
    if (hasRuntimeWorktrees(intent)) {
      const git = runtimeWorktreeGit(this.options.profile);
      if (!original) {
        const previous = team.owner
          .runtimeCaptures(operator)
          .toReversed()
          .map((registration) => {
            const record = this.record(store, registration.launchId);
            if (!record) throw new TeamLaunchError('hold', 'capture-record');
            return {
              record,
              source: runtimeCaptureSourceSchema.parse(record.definition.capture),
            };
          });
        const worktrees = await planRuntimeWorktrees({
          team,
          source: intent,
          git,
          previous,
          assertCurrent,
        });
        assertCurrent();
        intent = captureRuntimeSource(
          this.options.profile,
          team,
          commandId,
          input.rosterCommandId,
          roster,
          { worktrees, deferMcp: true, sourceReferences: intent.recipeSources ?? [],
            ...(this.options.sources ? { sources: this.options.sources } : {}) }
        );
        team.owner.withLaunchAuthority(operator, 'control', () => {
          assertCurrent();
          prepareWorktreeLaunch(store, {
            launchId,
            rosterRevision: intent.configurationRevision,
            intent: JSON.parse(JSON.stringify(intent)),
            admission: expectedAdmission,
          });
        });
      }
      if (original?.worktreePreparation?.completedSourceDigest) {
        if (
          original.worktreePreparation.completedSourceDigest !==
          runtimeDigest(original.definition.capture)
        )
          throw new TeamLaunchError('hold', 'capture-worktree-finalization');
        source = runtimeCaptureSourceSchema.parse(original.definition.capture);
      } else {
        await materializeRuntimeWorktrees({
          profile: this.options.profile,
          team,
          source: intent,
          store,
          launchId,
          git,
          assertCurrent,
        });
        assertCurrent();
        source = await finalizeSource({
          worktrees: intent.worktrees,
          worktreeIntentDigest: runtimeDigest(intent),
          worktreeBindings: this.record(store, launchId)!.worktrees!.map((receipt) => {
            if (receipt.state !== 'completed' || !receipt.binding)
              throw new TeamLaunchError('hold', 'worktree-receipt-incomplete');
            return receipt.binding;
          }),
        });
        assertCurrent();
      }
    } else {
      source = original
        ? runtimeCaptureSourceSchema.parse(original.definition.capture)
        : await finalizeSource();
    }
    const compiled = compileRuntimeCapture(this.options.profile, team, source, 'launch', this.options.sources);
    assertCurrent();
    const registration: TeamRuntimeCapture = {
      commandId,
      configurationRevision: source.configurationRevision,
      launchId: compiled.registration.launchId,
      members: compiled.registration.members,
    };
    // Finalize the same launch record only after materialization and actual-cwd catalog capture.
    // Expected native configuration still precedes Team selection and every native allocation.
    this.options.install(capturedTeam(team, source, registration), compiled.profiles, 'prepare');
    assertCurrent();
    team.owner.registerRuntime(operator, compiled.registration);
    this.options.install(capturedTeam(team, source, registration), compiled.profiles, 'activate');
    return registration.launchId;
  }

  /** Native append receipts preserve this one original run; never register a replacement roster. */
  private nativeSuccessor(team: HostedTeam, registration: TeamRuntimeCapture): boolean {
    const record = this.record(this.store(team), registration.launchId);
    if (!record?.nativeAdditions?.length) return false;
    const source = this.source(team, registration), lead = source.members.find(member => member.role === 'lead');
    const selected = registration.members.find(member => member.memberId === lead?.memberId);
    if (!lead || !selected) return false;
    return team.owner.nativeRoster.capturedMemberCurrent(this.options.profile.principalId,
      source.configurationRevision, { memberId: lead.memberId, name: lead.name, role: lead.role,
        settings: lead.settings, delivery: selected.delivery }, source.savedSettings);
  }

  private store(team: HostedTeam): TeamOwnerStore {
    return new TeamOwnerStore(
      this.options.profile.owner.storageRoot,
      team.definition.binding.teamName
    );
  }

  private record(store: TeamOwnerStore, launchId: string): TeamLaunchRecord | undefined {
    const path = `launches/${runtimeDigest(launchId)}.json`;
    let stat;
    try {
      stat = lstatSync(join(store.directory, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new TeamLaunchError('hold', 'capture-record');
    const record = store.read<TeamLaunchRecord>(path);
    if (
      !record ||
      record.schemaVersion !== 1 ||
      !record.definition ||
      record.definition.launchId !== launchId ||
      record.fingerprint !== runtimeDigest(record.definition)
    )
      throw new TeamLaunchError('hold', 'capture-record');
    validateLaunchRecord(record, record.fingerprint, record.definition.members.length);
    validateNativeLaunchAdditions(record);
    validateMemberSelectionChain(record);
    return record;
  }

  private assertRecordScope(team: HostedTeam, record: TeamLaunchRecord | undefined): void {
    for (const member of record?.definition.members ?? []) {
      if (!member.binding) continue;
      const binding = normalizeBinding(member.binding);
      if (binding.backendId !== team.definition.binding.backendId ||
          binding.teamId !== team.definition.binding.teamId || binding.runId !== record!.definition.launchId ||
          binding.memberId !== member.memberId)
        throw new TeamLaunchError('hold', 'capture-binding');
    }
  }

  private source(team: HostedTeam, registration: TeamRuntimeCapture) {
    const record = this.record(this.store(team), registration.launchId);
    this.assertRecordScope(team, record);
    if (
      !record ||
      (record.worktreePreparation &&
        record.worktreePreparation.completedSourceDigest !==
          runtimeDigest(record.definition.capture))
    )
      throw new TeamLaunchError('hold', 'capture-record');
    const source = runtimeCaptureSourceSchema.parse(record.definition.capture);
    if (
      source.commandId !== registration.commandId ||
      source.configurationRevision !== registration.configurationRevision
    )
      throw new TeamLaunchError('hold', 'capture-source');
    const expected = runtimeCaptureRegistration(team, source);
    if (expected.launchId !== registration.launchId ||
        runtimeDigest(expected.members) !== runtimeDigest(registration.members))
      throw new TeamLaunchError('hold', 'capture-binding');
    validateRuntimeCaptureMcpArtifacts(this.options.profile, team, source);
    return source;
  }

  private restoreCapture(
    team: HostedTeam,
    registration: TeamRuntimeCapture,
    activate: boolean
  ): void {
    const source = this.source(team, registration),
      compiled = compileRuntimeCapture(this.options.profile, team, source, 'launch', this.options.sources);
    if (
      compiled.registration.launchId !== registration.launchId ||
      runtimeDigest(compiled.registration.members) !== runtimeDigest(registration.members)
    )
      throw new TeamLaunchError('hold', 'capture-binding');
    this.options.install(
      capturedTeam(team, source, registration),
      compiled.profiles,
      activate ? 'activate' : 'retain'
    );
  }
}

function needsRuntimeRestore(profile: TeamHostProfile, team: HostedTeam): boolean {
  return !!profile.runtime?.members.some(member => member.teamId === team.definition.binding.teamId) ||
    hasRetainedRuntime(profile, team);
}

/** Presence does not grant actor read or confirm that original custody was released. */
function hasRetainedRuntime(profile: TeamHostProfile, team: HostedTeam): boolean {
  if (team.owner.hasRetainedRuntime()) return true;
  const store = new TeamOwnerStore(profile.owner.storageRoot, team.definition.binding.teamName);
  try {
    const stat = lstatSync(join(store.directory, 'launches', runtimeDigest(team.definition.scope.runId) + '.json'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new TeamLaunchError('hold', 'capture-record');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return false;
}

/** Missing current runtime does not erase original seed/capture history or its cleanup debt. */
export function hasRetainedTeamRuntime(profile: TeamHostProfile, teams: ReadonlyMap<string, HostedTeam>): boolean {
  for (const team of teams.values())
    if (hasRetainedRuntime(profile, team)) return true;
  return false;
}
