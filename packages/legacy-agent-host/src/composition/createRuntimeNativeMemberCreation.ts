import { createHash } from 'node:crypto';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { TeamOwnerError } from '../team/contracts.js';
import { runtimeDigest, normalizeBinding } from '../runtime/identity.js';
import { initialContextDigest } from '../team-launch/context.js';
import { inheritNativeMemberMcp } from './inheritNativeMemberMcp.js';
import { capturedMcpSourceCurrent } from '../mcp-catalog/capturedSource.js';
import {
  prepareCapturedRuntimeMcpRecipes,
  loadCapturedRuntimeMcpRecipe,
} from './capturedRuntimeMcpRecipes.js';
import { createNativeMemberCreation } from './createNativeMemberCreation.js';
import { createMemberEntry } from './createMemberEntry.js';
import {
  nativeMemberCaptureSource,
  nativeMemberBaseRecipe,
  compileNativeMemberRuntimeCapture,
} from './nativeMemberRuntimeCapture.js';
import { memberInitialInstructions } from './TeamLaunchComposition.js';
import type {
  NativeMemberCreationAuthority,
  NativeMemberCreationInput,
} from '../team/nativeMemberCreationContracts.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { MemberEntry, HostedTeam } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { JsonValue } from '../contracts.js';

export interface RetainedNativeLaunch {
  team: HostedTeam;
  launch: TeamLaunchOwner;
  entries: MemberEntry[];
}
export type NativeMemberModelPreflight = (options: {
  profile: RuntimeMemberProfile;
  source: NativeMemberCreationAuthority;
  input: NativeMemberCreationInput;
  assertCurrent(): void;
}) => Promise<void>;

/** Composition callback only; the host's existing management owner retains all one-off probe resources. */
export function createRuntimeNativeMemberCreation(options: {
  profile: TeamHostProfile;
  retainedLaunches: ReadonlyMap<string, RetainedNativeLaunch>;
  entries: Map<string, MemberEntry>;
  runtime: RuntimeOwner;
  preflight?: NativeMemberModelPreflight;
  assertCurrent(): void;
  trackOpening<T>(pending: Promise<T>): Promise<T>;
}) {
  return async (
    sourceEntry: MemberEntry,
    operation: 'create' | 'lookup',
    raw: unknown,
    source: NativeMemberCreationAuthority
  ): Promise<JsonValue> => {
    const team = sourceEntry.team,
      launchId = source.team.source.runId;
    const retained = options.retainedLaunches.get(
      runtimeDigest({ teamId: source.team.source.teamId, launchId })
    );
    if (!retained || retained.team.owner !== team.owner || !retained.entries.includes(sourceEntry))
      throw new TeamOwnerError('hold');
    const owner = team.owner.nativeRoster.nativeCreation();
    const current = () => {
      options.assertCurrent();
      source.assertCurrent();
      if (!capturedMcpSourceCurrent(sourceEntry.profile)) throw new TeamOwnerError('hold');
    };
    const usecase = createNativeMemberCreation({
      owner,
      assertCurrent: options.assertCurrent,
      runtime: {
        async prepare(input, expected, original) {
          current();
          if (!options.preflight) throw new TeamOwnerError('hold');
          const leadProvider =
            sourceEntry.profile.provider === 'claude' ? 'anthropic' : sourceEntry.profile.provider;
          const intent = nativeMemberCaptureSource(retained.team, input, expected, leadProvider);
          const base = nativeMemberBaseRecipe(
            options.profile,
            team.definition.binding.teamId,
            intent
          );
          // Default inheritLead policy uses the admitted lead's frozen selection, never target ambient MCP.
          const selected = [inheritNativeMemberMcp(base, sourceEntry.profile)];
          const store = new TeamOwnerStore(
            options.profile.owner.storageRoot,
            team.definition.binding.teamName
          );
          const references = await prepareCapturedRuntimeMcpRecipes({
            store,
            commandId: input.commandId,
            baseRecipes: [base],
            selectedRecipes: selected,
            assertCurrent: current,
            withAuthority: (callback) => owner.withPrepared(original, input, callback),
          });
          current();
          const reference = references[0]!;
          // Hash the original persisted recipe, including target-only native census and normalized policy.
          const selectedRecipe = loadCapturedRuntimeMcpRecipe(
            store,
            input.commandId,
            base,
            reference
          );
          const compiled = compileNativeMemberRuntimeCapture(options.profile, team, {
            ...intent,
            mcpRecipeReference: reference,
            recipeDigest: runtimeDigest(selectedRecipe),
          });
          const targetTeam = nativeMemberHostedTeam(
            retained.team,
            compiled.capture.member,
            compiled.selection,
            expected.revision
          );
          return {
            ...compiled,
            targetTeam,
            entry: undefined as MemberEntry | undefined,
            input,
            source: original,
          };
        },
        expected(captured, authorized) {
          const { capture, input, profile, selection } = captured;
          retained.launch.appendExpectedNativeMember(
            {
              commandId: input.commandId,
              inputAuthority: source.fingerprint,
              rosterRevision: capture.configurationRevision,
              member: {
                memberId: profile.memberId,
                binding: normalizeBinding(selection.delivery),
                configurationDigest: runtimeDigest(profile),
                baseConfigurationDigest: runtimeDigest(profile),
                runtimeGeneration: profile.generation,
                configRevision: profile.configRevision,
                contextDigest: initialContextDigest(
                  memberInitialInstructions(
                    capture.member.name,
                    'member',
                    selection.delivery.teamName,
                    profile.cwd
                  )
                ),
                skipped: false,
                timeoutMs: profile.limits.timeoutMs,
              },
              capture: JSON.parse(JSON.stringify(capture)) as JsonValue,
            },
            authorized
          );
          captured.entry = createMemberEntry({
            root: options.profile.owner.storageRoot,
            ownerId: options.profile.owner.ownerId,
            team: captured.targetTeam,
            baseProfile: profile,
          });
        },
        selection: (captured) => captured.selection,
        async install(captured, assertAllocationCurrent) {
          const guard = () => {
            current();
            assertAllocationCurrent();
            owner.withConfigured(captured.source, captured.input, () => {});
          };
          guard();
          await options.preflight!({
            profile: captured.profile,
            source: captured.source,
            input: captured.input,
            assertCurrent: guard,
          });
          guard();
          const key = runtimeDigest(captured.entry!.binding);
          if (options.entries.has(key)) throw new TeamOwnerError('conflict');
          // The launch callbacks close over this SAME array. Existing peer entries never change.
          options.entries.set(key, captured.entry!);
          retained.entries.push(captured.entry!);
          await options.trackOpening(
            retained.launch.startMember(
              captured.entry!.profile.memberId,
              guard,
              captured.input.commandId
            ) ?? Promise.resolve()
          );
          guard();
          const observed = options.runtime.readCapturedSession(captured.entry!.binding);
          if (!observed.attached || observed.record?.phase !== 'allocated')
            throw new TeamOwnerError('hold');
        },
        remindPeers(captured) {
          current();
          for (const peer of retained.entries) {
            if (peer === captured.entry) continue;
            const observed = options.runtime.readCapturedSession(peer.binding),
              record = observed.record;
            if (
              !observed.attached ||
              !record?.sessionRef ||
              record.phase !== 'allocated' ||
              record.sealed ||
              record.custody !== 'owned'
            )
              continue;
            const sourceRef = `native-roster:${captured.capture.configurationRevision}`;
            const epochId = createHash('sha256')
              .update(
                JSON.stringify({
                  binding: peer.binding,
                  sessionRef: record.sessionRef,
                  sourceRef,
                })
              )
              .digest('hex');
            team.owner.contextReminders.observe(peer.profile.principalId, peer.binding, {
              epochId,
              sessionRef: record.sessionRef,
              sourceRef,
            });
          }
        },
      },
    });
    const value =
      operation === 'lookup' ? usecase.lookup(source, raw) : await usecase.add(source, raw);
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  };
}

/** The original peer capture stays immutable; only the new target gets this additive descriptor. */
export function nativeMemberHostedTeam(
  team: HostedTeam,
  member: import('./nativeMemberRuntimeCapture.js').NativeMemberRuntimeCapture['member'],
  selection: ReturnType<typeof compileNativeMemberRuntimeCapture>['selection'],
  revision: string
): HostedTeam {
  return {
    ...team,
    configurationRevision: revision,
    definition: {
      ...team.definition,
      members: [...team.definition.members, { ...member, delivery: selection.delivery }],
      grants: [
        ...team.definition.grants,
        {
          principalId: selection.principalId,
          memberName: member.name,
          permissions: ['read', 'task.write', 'message.write', 'process.write'],
        },
      ],
    },
  };
}
