import { executeCapturedRuntimeControl } from './executeCapturedRuntimeControl.js';
import { readGroupRuntime, selectCurrentGroupEntry } from './readGroupRuntime.js';
import type { MemberInputCapture } from './createRuntimeMemberProviderFactory.js';
import type { TeamMcpGroupPort } from '../mcp/groupChatTools.js';
import { runtimeLaunchMembers } from './runtimeLaunchMembers.js';
import { createRuntimeNativeMemberCreation } from './createRuntimeNativeMemberCreation.js';
import type {
  NativeMemberModelPreflight,
  RetainedNativeLaunch,
} from './createRuntimeNativeMemberCreation.js';
import { restoreNativeRuntimeEntries } from './restoreNativeRuntimeEntries.js';
import { createRuntimeWorkSyncWake } from './createRuntimeWorkSyncWake.js';
import { createRuntimeMemberProviderFactory } from './createRuntimeMemberProviderFactory.js';
import { executeRuntimeMemberAction } from './executeRuntimeMemberAction.js';
import type { RuntimeMemberActionOperation } from './executeRuntimeMemberAction.js';
import type { NativeMemberActionSource } from './nativeMemberActionAdmission.js';
import type { createHostWorkSyncComposition } from './createHostWorkSyncComposition.js';
import { createRuntimeLifecyclePorts } from './createRuntimeLifecyclePorts.js';
import { executeRuntimeLaunch } from './executeRuntimeLaunch.js';
import type {
  RuntimeLaunchAsyncOperation,
  RuntimeLaunchSyncOperation,
  RuntimeLaunchOperation,
} from './executeRuntimeLaunch.js';
import { readLeadObservation } from './readLeadObservation.js';
import { createTeamContextPreparation } from './createTeamContextPreparation.js';
import { projectRuntimeMember } from './projectRuntimeMember.js';
import type { ProcessCustody } from './processCustody.js';
import type { TeamMcpCrossTeamPort } from '../mcp/nativeCrossTeamContracts.js';
import { readHostTeamActivity } from './readHostTeamActivity.js';
import { HostInteractionControls } from './HostInteractionControls.js';
import { createMemberEntry, createPreparedMemberEntry } from './createMemberEntry.js';
import { projectRuntimeActivity } from './runtimeActivityProjection.js';
import { createRuntimeTeamLaunch } from './createRuntimeTeamLaunch.js';
import { RuntimeTeamCaptures } from './RuntimeTeamCaptures.js';
import { ToolEvidenceWindows } from '../evidence/ToolEvidenceWindows.js';
import { captureTeamModelProbeSelection, isCurrentCapturedTeam } from './savedTeamModelProbe.js';
import { assertCapturedRosterCurrent, assertRosterEditable } from './teamRoster.js';
import type { TeamModelProbeSelection } from './teamLaunchModelProbe.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { randomUUID } from 'node:crypto';

import { FileRuntimeStore } from '../adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../runtime/identity.js';

import type {
  MemberProviderContext,
  MemberProvider,
} from '../adapters/providers/MemberProvider.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type {
  RuntimeActivityCursor,
  RuntimeActivityFeed,
  RuntimeActivitySnapshot,
} from '../runtime/activityContracts.js';

import type { HostedTeam, MemberEntry } from './MemberEntry.js';
export type { HostedTeam } from './MemberEntry.js';

/** Actual Team + Runtime + D composition, without a second input queue or native protocol parser. */
export class RuntimeTeamCoordinator {
  private readonly entries = new Map<string, MemberEntry>();
  private readonly runtime: RuntimeOwner;
  private readonly interactionControls: HostInteractionControls;
  private readonly launches = new Map<string, TeamLaunchOwner>();
  private readonly retainedLaunches = new Map<string, RetainedNativeLaunch>();
  private readonly capturedTeams = new Map<string, HostedTeam>();
  private readonly captures: RuntimeTeamCaptures;
  private readonly hostIncarnation = randomUUID();
  private readonly evidenceWindows = new ToolEvidenceWindows();
  private readonly opening = new Set<Promise<unknown>>();
  private pumping: Promise<void> | undefined;
  private readonly workSyncWake: ReturnType<typeof createRuntimeWorkSyncWake>;
  private dirty = false;
  private sealed = false;

  constructor(
    private readonly options: {
      profile: TeamHostProfile;
      teams: ReadonlyMap<string, HostedTeam>;
      assertWriter(): void;
      processCustody?: ProcessCustody;
      workSync?: ReturnType<typeof createHostWorkSyncComposition>;
      nativeMemberModelPreflight?: NativeMemberModelPreflight;
      groups?(
        entry: MemberEntry,
        capture: MemberInputCapture,
        current: () => boolean
      ): TeamMcpGroupPort;
      crossTeam?(
        team: HostedTeam,
        principalId: string,
        binding: RuntimeBinding,
        isCurrent: () => boolean
      ): TeamMcpCrossTeamPort;
      /** Explicit composition seam for controlled Session tests; CLI always selects real D. */
      createProvider?(context: MemberProviderContext): MemberProvider;
    }
  ) {
    for (const baseProfile of options.profile.runtime?.members ?? []) {
      const team = options.teams.get(baseProfile.teamId);
      if (!team) throw new RuntimeOwnerError('invalid');
      const entry = createMemberEntry({
        root: options.profile.owner.storageRoot,
        ownerId: options.profile.owner.ownerId,
        team,
        baseProfile,
      });
      const key = this.key(entry.binding);
      if (this.entries.has(key)) throw new RuntimeOwnerError('invalid');
      this.entries.set(key, entry);
    }
    const store = new FileRuntimeStore(options.profile.owner.storageRoot);
    if (
      new Set([...this.entries.values()].map((entry) => runtimeDigest(entry.config))).size !==
      this.entries.size
    )
      throw new RuntimeOwnerError('invalid');
    this.runtime = new RuntimeOwner({
      store,
      checkpoints: store,
      events: store,
      profileId: options.profile.owner.profileId,
      hostIncarnation: this.hostIncarnation,
      driverFactory: createRuntimeMemberProviderFactory({
        entries: this.entries,
        storageRoot: options.profile.owner.storageRoot,
        profileId: options.profile.owner.profileId,
        principalId: options.profile.principalId,
        hostIncarnation: this.hostIncarnation,
        windows: this.evidenceWindows,
        ...(options.processCustody ? { processCustody: options.processCustody } : {}),
        ...(options.createProvider ? { createProvider: options.createProvider } : {}),
        groups: (entry, capture, current) => options.groups?.(entry, capture, current),
        crossTeam: (entry, isCurrent) =>
          options.crossTeam?.(entry.team, entry.profile.principalId, entry.delivery, isCurrent),
        workSync: (entry, captureSource, delivery) =>
          options.workSync?.member({
            teamId: entry.delivery.teamId,
            teamName: entry.delivery.teamName,
            owner: entry.team.owner,
            providerId: entry.profile.provider === 'claude' ? 'anthropic' : entry.profile.provider,
            sourceRevision: runtimeDigest({ binding: entry.binding, configuration: entry.config }),
            captureSource,
            delivery,
          }),
        settleDeliveries: async (entry, assertOriginal) => {
          assertOriginal();
          this.assertCurrent(entry);
          await entry.team.owner.resumeDeliveries(this.deliveryPort());
          assertOriginal();
          this.assertCurrent(entry);
          await this.runtime.dispatchNext(entry.binding);
          assertOriginal();
          this.assertCurrent(entry);
        },
        nativeCreation: (entry, captureSource) => ({
          invoke: (operation, raw) =>
            createRuntimeNativeMemberCreation({
              profile: options.profile,
              retainedLaunches: this.retainedLaunches,
              entries: this.entries,
              runtime: this.runtime,
              ...(options.nativeMemberModelPreflight
                ? { preflight: options.nativeMemberModelPreflight }
                : {}),
              assertCurrent: () => {
                options.assertWriter();
                if (this.sealed) throw new RuntimeOwnerError('hold');
              },
              trackOpening: (pending) => this.trackOpening(pending),
            })(entry, operation, raw, captureSource(true)),
        }),
        nativeActions: (entry, captureSource) => ({
          invoke: (operation, commandId, raw) => {
            const source = captureSource(true);
            return this.executeMemberAction(
              entry.binding.teamId,
              operation,
              commandId,
              raw,
              source
            );
          },
        }),
        isSealed: () => this.sealed,
        assertCurrent: (entry) => this.assertCurrent(entry),
        captureInteractions: (entry) => this.interactionControls.capture(entry),
        readRuntime: (binding) => this.runtime.readCapturedSession(binding),
        readCheckpoint: (reference, request) => this.runtime.readCheckpoint(reference, request),
        observe: (binding, sessionRef, activity) =>
          this.runtime.observeProviderActivity(binding, sessionRef, activity),
        onProgress: () => this.kick(),
      }),
      authorize: (binding, action, intent) => {
        options.assertWriter();
        const entry =
          this.entries.get(this.key(binding)) ??
          (action === 'read'
            ? [...this.entries.values()].find(
                (candidate) =>
                  candidate.binding.teamId === binding.teamId &&
                  candidate.binding.memberId === binding.memberId
              )
            : undefined);
        if (!entry) return false;
        if (intent) return entry.team.owner.authorizeDeliveryIntent(intent, action);
        return (
          entry.team.owner.authorizeMemberBinding(binding, action) ||
          (action === 'read' &&
            this.entries.has(this.key(binding)) &&
            entry.team.owner.withLaunchAuthority(
              options.profile.principalId,
              'read',
              () => true
            )) ||
          ((action === 'read' || action === 'control') &&
            entry.team.owner.authorizeRuntimeAccess(options.profile.principalId, binding, action))
        );
      },
      ...createTeamContextPreparation({
        entries: this.entries,
        principalId: options.profile.principalId,
        assertCurrent: (entry) => this.assertCurrent(entry),
      }),
      canDispatch: (binding) => {
        const entry = this.entries.get(this.key(binding));
        return (
          !!entry?.provider?.isReady() &&
          this.isCurrent(entry) &&
          !!this.launches
            .get(entry.profile.teamId)
            ?.canWork(entry.profile.memberId, entry.provider.initialContextEvidence?.())
        );
      },
    });
    this.workSyncWake = createRuntimeWorkSyncWake({
      entries: this.entries,
      isCurrent: (entry) => this.isCurrent(entry),
      isSealed: () => this.sealed,
    });
    this.interactionControls = new HostInteractionControls({
      runtime: this.runtime,
      principalId: options.profile.principalId,
      assertCurrent: (entry) => this.assertCurrent(entry),
      kick: () => this.kick(),
    });
    for (const team of options.teams.values()) {
      const entries = [...this.entries.values()].filter((entry) => entry.team === team);
      if (entries.length) this.installLaunch(team, entries, true);
    }
    this.captures = new RuntimeTeamCaptures({
      profile: options.profile,
      teams: options.teams,
      assertCurrent: () => {
        options.assertWriter();
        if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
      },
      install: (team, profiles, mode) => {
        const entries = profiles.map((baseProfile) => {
          // Finalize the expected roster before consulting finalized binding selections.
          // Preparation entries stay out of both the runtime and retained-launch registries.
          const project = mode === 'prepare' ? createPreparedMemberEntry : createMemberEntry;
          const next = project({
            root: options.profile.owner.storageRoot,
            ownerId: options.profile.owner.ownerId,
            team,
            baseProfile,
          });
          const key = this.key(next.binding),
            prior = this.entries.get(key);
          if (prior) {
            if (
              runtimeDigest(prior.baseProfile) !== runtimeDigest(next.baseProfile) ||
              runtimeDigest(prior.team.capture) !== runtimeDigest(next.team.capture)
            )
              throw new RuntimeOwnerError('conflict');
            return prior;
          }
          if (mode !== 'prepare') this.entries.set(key, next);
          return next;
        });
        this.installLaunch(entries[0]!.team, entries, mode === 'activate', mode === 'prepare');
      },
    });
    this.captures.restore();
  }

  private installLaunch(
    team: HostedTeam,
    entries: MemberEntry[],
    active: boolean,
    prepare = false
  ): void {
    const launchId = team.launchId ?? team.definition.scope.runId;
    const key = runtimeDigest({ teamId: team.definition.binding.teamId, launchId });
    let captured = this.retainedLaunches.get(key);
    if (!captured) {
      restoreNativeRuntimeEntries({
        profile: this.options.profile,
        team,
        entries,
        registry: this.entries,
      });
      captured = {
        team,
        entries,
        launch: createRuntimeTeamLaunch({
          root: this.options.profile.owner.storageRoot,
          team,
          entries,
          principalId: this.options.profile.principalId,
          hostIncarnation: this.hostIncarnation,
          runtime: this.runtime,
          isCurrent: (entry) => this.isCurrent(entry),
          isSealed: () => this.sealed,
          assertWriter: () => this.options.assertWriter(),
          trackOpening: (pending) => this.trackOpening(pending),
          onProgress: () => this.kick(),
        }),
      };
      if (!prepare) this.retainedLaunches.set(key, captured);
    }
    if (active) {
      this.capturedTeams.set(team.definition.binding.teamId, captured.team);
      this.launches.set(team.definition.binding.teamId, captured.launch);
    }
  }

  hasCurrentCapture(teamId: string): boolean {
    return isCurrentCapturedTeam(this.capturedTeams.get(teamId));
  }

  readLaunchAdmission(teamId: string, launchId: string, commandId: string) {
    this.options.assertWriter();
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    const selected = this.retainedLaunches.get(runtimeDigest({ teamId, launchId }));
    if (!selected) throw new TeamLaunchError('hold', 'capture-unavailable');
    return selected.launch.readOriginalStart(commandId);
  }

  private async trackOpening<T>(pending: Promise<T>): Promise<T> {
    this.opening.add(pending);
    try {
      return await pending;
    } finally {
      this.opening.delete(pending);
    }
  }

  executeMemberAction(
    teamId: string,
    operation: RuntimeMemberActionOperation | 'retry',
    commandId: string,
    raw: unknown,
    nativeSource?: NativeMemberActionSource
  ) {
    return executeRuntimeMemberAction(
      {
        ...(nativeSource ? { nativeSource } : {}),
        retainedLaunches: this.retainedLaunches,
        entries: this.entries,
        runtime: this.runtime,
        principalId: this.options.profile.principalId,
        assertCurrent: () => this.options.assertWriter(),
        isSealed: () => this.sealed,
      },
      teamId,
      operation,
      commandId,
      raw
    );
  }

  executeLaunch(
    teamId: string,
    operation: RuntimeLaunchAsyncOperation,
    commandId: string,
    raw: unknown
  ): Promise<JsonValue>;
  executeLaunch(
    teamId: string,
    operation: RuntimeLaunchSyncOperation,
    commandId: string,
    raw: unknown
  ): JsonValue;
  executeLaunch(
    teamId: string,
    operation: RuntimeLaunchOperation,
    commandId: string,
    raw: unknown
  ): JsonValue | Promise<JsonValue>;
  executeLaunch(
    teamId: string,
    operation: RuntimeLaunchOperation,
    commandId: string,
    raw: unknown
  ): JsonValue | Promise<JsonValue> {
    return executeRuntimeLaunch(
      {
        profile: this.options.profile,
        teams: this.options.teams,
        capturedTeams: this.capturedTeams,
        launches: this.launches,
        retainedLaunches: this.retainedLaunches,
        entries: this.entries,
        runtime: this.runtime,
        capture: (id, command, value) =>
          this.trackOpening(this.captures.capture(id, command, value)),
        hasCurrentCapture: (id) => this.hasCurrentCapture(id),
        isSealed: () => this.sealed,
        assertCurrent: () => this.options.assertWriter(),
      },
      teamId,
      operation,
      commandId,
      raw
    );
  }

  captureLaunchModelProbe(
    teamId: string,
    input: TeamModelProbeSelection,
    action: 'start' | 'read' | 'cancel'
  ) {
    return captureTeamModelProbeSelection({
      profile: this.options.profile,
      team: this.options.teams.get(teamId),
      capturedTeam: this.capturedTeams.get(teamId),
      launch: this.launches.get(teamId),
      entries: [...this.entries.values()],
      input,
      action,
      assertCurrent: () => {
        this.options.assertWriter();
        if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
      },
    });
  }

  /** Prove original resources released before changing their saved product settings. */
  assertRosterEditable(
    teamId: string,
    members: readonly import('../team/contracts.js').TeamMember[]
  ): void {
    this.options.assertWriter();
    if (this.sealed) throw new RuntimeOwnerError('hold');
    for (const { team, launch, entries } of this.retainedLaunches.values()) {
      if (team.definition.binding.teamId !== teamId) continue;
      assertRosterEditable({
        members: runtimeLaunchMembers(team, entries),
        launch,
        runtime: this.runtime,
        entries,
      });
    }
    if (members.some((row) => row.delivery) && !this.capturedTeams.has(teamId))
      throw new RuntimeOwnerError('hold');
  }

  /** Seal before awaiting provider/control cleanup, including factories still opening. */
  seal(): void {
    this.sealed = true;
    this.interactionControls.seal();
    this.dirty = false;
    for (const { launch } of this.retainedLaunches.values()) launch.seal();
    for (const entry of this.entries.values()) entry.provider?.seal();
  }

  async settleTeamCommands(teamId: string): Promise<void> {
    if (this.sealed) throw new RuntimeOwnerError('hold');
    const team = this.options.teams.get(teamId);
    if (!team) throw new RuntimeOwnerError('invalid');
    await team.owner.resumeTaskCommands(this.deliveryPort());
  }

  kick(): void {
    if (this.sealed) return;
    this.dirty = true;
    if (this.pumping) return;
    this.pumping = Promise.resolve()
      .then(async () => {
        while (this.dirty && !this.sealed) {
          this.dirty = false;
          for (const launch of this.launches.values()) {
            try {
              launch.refresh();
            } catch {
              /* Original roster/custody debt remains held. */
            }
          }
          for (const team of this.options.teams.values()) {
            if (this.sealed) break;
            try {
              await team.owner.resumeTaskCommands(this.deliveryPort());
              if (this.sealed) break;
              await team.owner.resumeDeliveries(this.deliveryPort());
            } catch {
              /* Durable pending/held obligations remain with their original owner. */
            }
          }
          await this.interactionControls.pump(this.entries.values());
          for (const entry of this.entries.values()) {
            if (this.sealed) break;
            try {
              const current = this.runtime.readSession(entry.binding);
              if (
                current.attached &&
                current.record?.nativeReady &&
                current.record.phase === 'allocated'
              )
                await this.runtime.dispatchNext(entry.binding);
              await entry.settleWorkSync?.();
            } catch {
              /* A busy/held/revoked member never falls back to another runtime. */
            }
          }
        }
      })
      .finally(() => {
        this.pumping = undefined;
        if (this.dirty && !this.sealed) this.kick();
      });
  }

  groupRun(teamId: string, memberName: string) {
    const team = this.options.teams.get(teamId);
    const binding = team?.owner
      .crossTeamIdentity(this.options.profile.principalId)
      .members.find((member) => member.name === memberName)?.delivery;
    return readGroupRuntime({
      entry: selectCurrentGroupEntry(this.entries.values(), binding),
      read: (binding) => this.runtime.readSession(binding),
      current: (entry) => !this.sealed && this.isCurrent(entry),
    });
  }
  crossTeamActiveInputs(binding: RuntimeBinding) {
    const entry = this.entries.get(this.key(binding));
    if (!entry || !this.isCurrent(entry)) return [];
    const { record, attached } = this.runtime.readSession(binding);
    if (
      !attached ||
      !record ||
      record.sealed ||
      record.phase !== 'allocated' ||
      record.custody !== 'owned'
    )
      return [];
    return record.inputs
      .filter((input) => input.phase === 'claimed' || input.phase === 'consumed')
      .map((input) => structuredClone(input.intent));
  }

  readLead(teamId: string, kind: 'activity' | 'context'): JsonValue {
    return readLeadObservation(
      {
        team: this.options.teams.get(teamId),
        principalId: this.options.profile.principalId,
        entries: [...this.entries.values()],
        runtime: this.runtime,
        launch: this.launches.get(teamId)?.read(),
        isCurrent: (entry) => this.isCurrent(entry),
        assertCurrent: () => {
          this.options.assertWriter();
          if (this.sealed) throw new RuntimeOwnerError('hold');
        },
      },
      kind
    );
  }

  readTeamActivity(teamId: string, kind: 'logs' | 'stats', raw: unknown): JsonValue {
    return readHostTeamActivity(
      {
        team: this.options.teams.get(teamId),
        principalId: this.options.profile.principalId,
        entries: [...this.entries.values()],
        runtime: this.runtime,
        assertCurrent: () => {
          this.options.assertWriter();
          if (this.sealed) throw new RuntimeOwnerError('hold');
        },
      },
      kind,
      raw
    );
  }

  execute(teamId: string, operation: string, raw: unknown, commandId?: string): Promise<JsonValue> {
    return executeCapturedRuntimeControl(
      {
        teams: this.options.teams,
        capturedTeams: this.capturedTeams,
        entries: this.entries,
        launches: this.launches,
        runtime: this.runtime,
        interactionControls: this.interactionControls,
        principalId: this.options.profile.principalId,
        isSealed: () => this.sealed,
        assertWriter: () => this.options.assertWriter(),
        kick: () => this.kick(),
        dispatchSettled: () => this.pumping,
        closeEndpoint: (entry) => this.closeEndpoint(entry),
        rekey: (before, current) => {
          this.entries.delete(this.key(before));
          this.entries.set(this.key(current.binding), current);
        },
        projection: (entry, record, binding) => this.projection(entry, record, binding),
        activityProjection: (entry, source, requested) =>
          this.activityProjection(entry, source, requested),
      },
      teamId,
      operation,
      raw,
      commandId
    );
  }

  private activityProjection(
    entry: MemberEntry,
    source: RuntimeActivityFeed | RuntimeActivitySnapshot,
    requested?: RuntimeActivityCursor
  ): JsonValue {
    return projectRuntimeActivity({
      memberId: entry.profile.memberId,
      source,
      nativeReady: 'latest' in source && !!entry.provider?.isReady() && this.isCurrent(entry),
      ...(requested ? { requested } : {}),
    });
  }

  async close(): Promise<void> {
    this.seal();
    const openingEntries = [...this.entries.values()].filter((entry) => {
      try {
        return !!entry.provider && !this.runtime.readCapturedSession(entry.binding).attached;
      } catch {
        return false;
      } // A corrupt record must not skip original owned cleanup.
    });
    const stop = (entry: MemberEntry) => this.runtime.stopCapturedSession(entry.binding);
    // Each stop synchronously seals its Runtime record before the first cleanup await.
    const stopping = [...this.entries.values()].map(stop);
    const cleanup = async (entry: MemberEntry) =>
      entry.provider ? entry.provider.cleanup() : true;
    // An opening factory may need its original native transport closed before readiness can settle.
    // Allocated drivers retain checkpoint -> driver close -> process cleanup ordering below.
    const openingCleanup = new Map(openingEntries.map((entry) => [entry, cleanup(entry)]));
    await Promise.allSettled([
      this.workSyncWake.dispose(),
      ...stopping,
      ...openingCleanup.values(),
      ...this.opening,
      ...(this.pumping ? [this.pumping] : []),
    ]);
    let complete = true;
    for (const entry of this.entries.values()) {
      try {
        const state = await stop(entry);
        if (state && (state.phase !== 'closed' || state.custody !== 'released')) complete = false;
      } catch {
        complete = false;
      }
      // Physical cleanup of captured resources never depends on a still-valid user grant.
      try {
        if (!(await (openingCleanup.get(entry) ?? cleanup(entry)))) complete = false;
      } catch {
        complete = false;
      }
      try {
        await this.closeEndpoint(entry);
      } catch {
        complete = false;
      }
    }
    if (!complete) throw new RuntimeOwnerError('hold');
  }

  private projection(
    entry: MemberEntry,
    record: RuntimeSessionRecord | undefined,
    binding = entry.binding
  ): JsonValue {
    return projectRuntimeMember({
      entry,
      record,
      binding,
      runtime: this.runtime,
      isCurrent: () => this.isCurrent(entry),
    });
  }
  /** Trusted original trash cleanup; never registered as a Runtime RPC. */
  lifecyclePorts() {
    return createRuntimeLifecyclePorts({
      runtime: this.runtime,
      entries: this.entries,
      delivery: this.deliveryPort(),
      assertWriter: this.options.assertWriter,
      closeEndpoint: (entry) => this.closeEndpoint(entry),
    });
  }
  private deliveryPort() {
    return {
      fingerprintDelivery: deliveryFingerprint,
      admitDelivery: (intent: Parameters<RuntimeOwner['admitDelivery']>[0]) =>
        this.runtime.admitDelivery(intent),
      lookupDelivery: (intent: Parameters<RuntimeOwner['lookupDelivery']>[0]) =>
        this.runtime.lookupDelivery(intent),
      cancelDelivery: (intent: Parameters<RuntimeOwner['cancelDelivery']>[0]) =>
        this.runtime.cancelDelivery(intent),
    };
  }
  private key(binding: RuntimeBinding): string {
    return runtimeDigest(normalizeBinding(binding));
  }
  private isCurrent(entry: MemberEntry): boolean {
    try {
      this.assertCurrent(entry);
      return true;
    } catch {
      return false;
    }
  }
  private assertCurrent(entry: MemberEntry): void {
    this.options.assertWriter();
    assertCapturedRosterCurrent(entry.team, entry.profile.principalId);
    if (
      this.sealed ||
      (entry.endpointExpiresAtMs !== undefined && Date.now() >= entry.endpointExpiresAtMs) ||
      !entry.team.owner.authorizeMemberBinding(entry.binding, 'dispatch')
    )
      throw new RuntimeOwnerError('forbidden');
  }
  private async closeEndpoint(entry: MemberEntry): Promise<void> {
    entry.endpoint?.revoke();
    await entry.endpoint?.close();
  }
}
