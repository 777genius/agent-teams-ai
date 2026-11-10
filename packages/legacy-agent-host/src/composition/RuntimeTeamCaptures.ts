import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { runtimeDigest } from '../runtime/identity.js';
import { effectId } from '../team/identity.js';
import { prepareWorktreeLaunch } from '../team-launch/worktreePreparation.js';
import { prepareCapturedRuntimeMcpRecipes } from './capturedRuntimeMcpRecipes.js';
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
  runtimeCaptureRegistration,
  runtimeCaptureBaseRecipes,
  runtimeCaptureRecipeCandidates,
} from './runtimeCaptureSource.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { TeamLaunchRecord } from '../team-launch/contracts.js';
import type { TeamRuntimeCapture } from '../team/runtimeRegistrationContracts.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\0'));
export const captureTeamRuntimeSchema = z.object({ rosterCommandId: id }).strict();

/** Reuses Team's registration receipt and the existing immutable launch record; no native effects. */
export class RuntimeTeamCaptures {
  constructor(
    private readonly options: {
      profile: TeamHostProfile;
      teams: ReadonlyMap<string, HostedTeam>;
      assertCurrent(): void;
      install(
        team: HostedTeam,
        profiles: RuntimeMemberProfile[],
        mode: 'prepare' | 'retain' | 'activate'
      ): void;
    }
  ) {}

  restore(): void {
    for (const team of this.options.teams.values()) {
      const selected = team.owner.runtimeCapture(this.options.profile.principalId);
      for (const registration of team.owner.runtimeCaptures(this.options.profile.principalId))
        this.restoreCapture(team, registration, selected?.launchId === registration.launchId ||
          (!selected && this.nativeSuccessor(team, registration)));
    }
  }

  async capture(teamId: string, commandId: string, raw: unknown): Promise<string> {
    id.parse(commandId);
    const input = captureTeamRuntimeSchema.parse(raw),
      team = this.options.teams.get(teamId);
    if (!team) throw new TeamLaunchError('invalid', 'team');
    const operator = this.options.profile.principalId;
    team.owner.withLaunchAuthority(operator, 'control', () => undefined);
    const prior = team.owner.runtimeCaptures(operator).find((row) => row.commandId === commandId);
    if (prior) {
      const source = this.source(team, prior);
      if (source.rosterCommandId !== input.rosterCommandId)
        throw new TeamLaunchError('conflict', 'capture-command');
      // Registration replay rechecks current admin authority and the exact original payload.
      const compiled = compileRuntimeCapture(this.options.profile, team, source);
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
      if (
        team.connection.readRoster().revision !== intent.configurationRevision ||
        team.owner.assertRuntimeRegistration(operator, runtimeCaptureRegistration(team, intent)) !==
          expectedAdmission
      )
        throw new TeamLaunchError('hold', 'capture-authority-changed');
      // Initial intent binds original templates/accounts/options; final MCP reads wait for the actual cwd.
      compileRuntimeCapture(this.options.profile, team, intent, 'model-preflight');
    };
    assertCurrent();
    const finalizeSource = async (
      context: NonNullable<Parameters<typeof captureRuntimeSource>[5]> = {}
    ) => {
      const prepared = { ...intent, ...context };
      const baseRecipes = runtimeCaptureBaseRecipes(this.options.profile, teamId, prepared);
      const selectedRecipes = runtimeCaptureRecipeCandidates(this.options.profile, teamId, {
        ...prepared,
        mcpCaptureVersion: 1,
      });
      const mcpRecipeReferences = await prepareCapturedRuntimeMcpRecipes({
        store,
        commandId,
        baseRecipes,
        selectedRecipes,
        assertCurrent,
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
        { ...context, mcpRecipeReferences }
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
          { worktrees, deferMcp: true }
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
    const compiled = compileRuntimeCapture(this.options.profile, team, source);
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
    return record;
  }

  private source(team: HostedTeam, registration: TeamRuntimeCapture) {
    const record = this.record(this.store(team), registration.launchId);
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
    return source;
  }

  private restoreCapture(
    team: HostedTeam,
    registration: TeamRuntimeCapture,
    activate: boolean
  ): void {
    const source = this.source(team, registration),
      compiled = compileRuntimeCapture(this.options.profile, team, source);
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
