import { captureRuntimeControlAuthority } from './runtimeControlAuthority.js';
import { createCapturedTeamLaunch, memberInitialInstructions } from './TeamLaunchComposition.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { MemberEntry, HostedTeam } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';

/** Aggregate launch wiring. Both fresh open and selected restore retain Runtime allocation ownership. */
export function createRuntimeTeamLaunch(options: {
  root: string;
  team: HostedTeam;
  entries: MemberEntry[];
  principalId: string;
  hostIncarnation: string;
  runtime: RuntimeOwner;
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
