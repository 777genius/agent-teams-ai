import { captureRuntimeControlAuthority } from './runtimeControlAuthority.js';
import { createCapturedTeamLaunch, memberInitialInstructions } from './TeamLaunchComposition.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { MemberEntry, HostedTeam } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import { inspectMemberModelReadiness } from './prepareTeamModelReadiness.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import { restoreNativeRuntimeEntries } from './restoreNativeRuntimeEntries.js';
import { restoreLiveRosterRuntimeEntries } from './captureLiveRosterMember.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { RetainedNativeLaunch } from './createRuntimeNativeMemberCreation.js';
import type { LiveReadinessCapture } from '../team-launch/launchReadiness.js';

/** Aggregate launch wiring. Both fresh open and selected restore retain Runtime allocation ownership. */
export function createRuntimeTeamLaunch(options: {
  root: string;
  team: HostedTeam;
  entries: MemberEntry[];
  principalId: string;
  hostIncarnation: string;
  runtime: RuntimeOwner;
  modelReadiness?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  isCurrent(entry: MemberEntry): boolean;
  isSealed(): boolean;
  assertWriter(): void;
  trackOpening<T>(pending: Promise<T>): Promise<T>;
  onProgress(): void;
}) {
  const { team, entries, runtime } = options;
  const launch = createCapturedTeamLaunch({
    root: options.root,
    team,
    principalId: options.principalId,
    hostIncarnation: options.hostIncarnation,
    members: entries.map((entry) => {
      const selected = entry.team.definition.members.find(
        (member) => member.memberId === entry.profile.memberId
      )!;
      return {
        memberId: entry.profile.memberId,
        binding: entry.binding,
        configurationDigest: runtimeDigest(entry.profile),
        baseConfigurationDigest: runtimeDigest(entry.baseProfile),
        runtimeGeneration: entry.profile.generation,
        instructions: memberInitialInstructions(
          selected.name,
          selected.role,
          entry.delivery.teamName,
          entry.profile.cwd
        ),
        configRevision: entry.config.configRevision,
        timeoutMs: entry.profile.limits.timeoutMs,
        ...(entry.selection?.restore ? { restore: entry.selection.restore } : {}),
      };
    }),
    runtime: {
      assertModelReadiness(memberId) {
        const entry = entries.find(candidate => candidate.profile.memberId === memberId);
        if (!entry || entry.profile.provider !== 'opencode') return;
        if (!options.modelReadiness) throw new RuntimeOwnerError('hold');
        inspectMemberModelReadiness({ management: options.modelReadiness, launch, entry,
          assertCurrent: () => {
            options.assertWriter();
            if (options.isSealed() || !options.isCurrent(entry)) throw new RuntimeOwnerError('hold');
          } });
      },
      captureAuthority(memberId) {
        const entry = entries.find((candidate) => candidate.profile.memberId === memberId);
        if (!entry) throw new RuntimeOwnerError('invalid');
        const captured = captureRuntimeControlAuthority({
          entry,
          principalId: options.principalId,
          assertWriter: options.assertWriter,
          isSealed: options.isSealed,
        });
        return () => {
          team.owner.assertExecutionAllowed(options.principalId);
          captured();
        };
      },
      read(memberId) {
        const entry = entries.find((candidate) => candidate.profile.memberId === memberId);
        if (!entry) return { attached: false, nativeReady: false };
        const current = runtime.readSession(entry.binding),
          context = entry.provider?.initialContextEvidence?.();
        return {
          ...(current.record ? { record: current.record } : {}),
          attached: current.attached,
          nativeReady: !!entry.provider?.isReady() && options.isCurrent(entry),
          ...(context ? { context } : {}),
        };
      },
      async open(memberId, assertAuthority) {
        assertAuthority?.();
        const entry = entries.find((candidate) => candidate.profile.memberId === memberId);
        if (!entry || options.isSealed()) throw new RuntimeOwnerError('hold');
        const restore = entry.selection?.restore;
        await options.trackOpening(
          restore
            ? runtime.restoreSession(
                {
                  sourceBinding: restore.sourceBinding,
                  reference: restore.reference,
                  binding: entry.binding,
                  config: entry.config,
                },
                assertAuthority
              )
            : (() => {
                const sourceBinding = launch.readFreshMemberSource(entry.binding);
                return sourceBinding
                  ? runtime.openFreshMemberSession(
                      {
                        sourceBinding,
                        binding: entry.binding,
                        config: entry.config,
                      },
                      () => {
                        if (!assertAuthority) throw new RuntimeOwnerError('hold');
                        assertAuthority();
                        if (
                          runtimeDigest(launch.readFreshMemberSource(entry.binding)) !==
                          runtimeDigest(sourceBinding)
                        )
                          throw new RuntimeOwnerError('hold');
                      }
                    )
                  : runtime.openSession(
                      { binding: entry.binding, config: entry.config },
                      assertAuthority
                    );
              })()
        );
      },
    },
    onProgress: options.onProgress,
  });
  return launch;
}

/** Original coordinator installation body; the same maps and restore order remain authoritative. */
export function installRuntimeTeamLaunch(options: {
  profile: TeamHostProfile; runtime: RuntimeOwner; hostIncarnation: string;
  sources?: RuntimeRecipeSources;
  registry: Map<string, MemberEntry>;
  retainedLaunches: Map<string, RetainedNativeLaunch>;
  capturedTeams: Map<string, HostedTeam>; launches: Map<string, TeamLaunchOwner>;
  modelReadiness?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  isCurrent(entry: MemberEntry): boolean; isSealed(): boolean; assertWriter(): void;
  trackOpening<T>(pending: Promise<T>): Promise<T>; onProgress(): void;
}, team: HostedTeam, entries: MemberEntry[], active: boolean, prepare = false,
  liveReadinessCapture?: LiveReadinessCapture): void {
  const launchId = team.launchId ?? team.definition.scope.runId;
  const key = runtimeDigest({ teamId: team.definition.binding.teamId, launchId });
  let captured = options.retainedLaunches.get(key);
  if (!captured) {
    restoreNativeRuntimeEntries({ profile: options.profile, team, entries, registry: options.registry });
    captured = { team, entries, launch: createRuntimeTeamLaunch({
      root: options.profile.owner.storageRoot, team, entries,
      principalId: options.profile.principalId, hostIncarnation: options.hostIncarnation,
      runtime: options.runtime,
      ...(options.modelReadiness ? { modelReadiness: options.modelReadiness } : {}),
      isCurrent: options.isCurrent, isSealed: options.isSealed, assertWriter: options.assertWriter,
      trackOpening: options.trackOpening, onProgress: options.onProgress,
    }) };
    restoreLiveRosterRuntimeEntries({ profile: options.profile, team, entries, registry: options.registry,
      ...(options.sources ? { sources: options.sources } : {}), restoring: true });
    if (!prepare) options.retainedLaunches.set(key, captured);
  }
  if (active) {
    options.capturedTeams.set(team.definition.binding.teamId, captured.team);
    options.launches.set(team.definition.binding.teamId, captured.launch);
  }
  if (liveReadinessCapture) {
    if (!active || prepare) throw new TeamLaunchError('hold', 'capture-readiness-unavailable');
    captured.launch.admitModelReadinessCapture(liveReadinessCapture);
  }
}
