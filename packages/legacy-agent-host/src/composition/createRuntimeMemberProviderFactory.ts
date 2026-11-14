import type { TeamMcpGroupPort } from '../mcp/groupChatTools.js';
import { createMemberAttachmentPort } from './createMemberAttachmentPort.js';
import type { TeamMcpNativeMemberCreationPort } from '../mcp/nativeMemberCreationContracts.js';
import { createClaudeMemberProvider } from '../adapters/providers/ClaudeMemberProvider.js';
import { createCodexMemberProvider } from '../adapters/providers/CodexMemberProvider.js';
import { createOpenCodeMemberProvider } from '../adapters/providers/OpenCodeMemberProvider.js';
import { createOpenCodeV2EmbeddedMemberProvider } from '../adapters/providers/OpenCodeV2EmbeddedMemberProvider.js';
import { startTeamMcpEndpoint } from '../mcp/endpoint.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { captureMemberProviderAuthority } from './captureMemberProviderAuthority.js';
import { captureNativeInputAuthority } from './captureNativeInputAuthority.js';
import { createClaudeSubagents } from './createClaudeSubagents.js';
import { createClaudeCheckpointSource } from './createClaudeCheckpointSource.js';
import { createMemberEvidenceCapture } from './createMemberEvidenceCapture.js';
import { createMemberProcessMcpPort } from './createMemberProcessMcpPort.js';
import { assertRuntimeWorktree } from './runtimeWorktreeCapture.js';
import { memberInitialInstructions } from './TeamLaunchComposition.js';
import type { RuntimeOwnerOptions } from '../runtime/contracts.js';
import type {
  MemberProvider,
  MemberProviderContext,
} from '../adapters/providers/MemberProvider.js';
import type { ToolEvidenceWindows } from '../evidence/ToolEvidenceWindows.js';
import type { TeamMcpCrossTeamPort } from '../mcp/nativeCrossTeamContracts.js';
import type { NativeWorkSyncMemberContext } from './nativeWorkSyncContext.js';
import type { createHostWorkSyncComposition } from './createHostWorkSyncComposition.js';
import type { TeamMcpNativeMemberActionPort } from '../mcp/nativeMemberActionContracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { MemberEntry } from './MemberEntry.js';
import type { ProcessCustody } from './processCustody.js';
import { consumeMemberModelReadiness } from './prepareTeamModelReadiness.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';

export type MemberInputCapture = (
  requireLead?: boolean
) => ReturnType<typeof captureNativeInputAuthority>;
/** One original provider factory, shared finite MCP connection and immutable target lifetime. */
export function createRuntimeMemberProviderFactory(options: {
  entries: ReadonlyMap<string, MemberEntry>;
  storageRoot: string;
  profileId: string;
  principalId: string;
  hostIncarnation: string;
  windows: ToolEvidenceWindows;
  modelReadiness?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget'>;
  readinessLaunch?(entry: MemberEntry): TeamLaunchOwner | undefined;
  processCustody?: ProcessCustody;
  createProvider?(context: MemberProviderContext): MemberProvider;
  groups?(
    entry: MemberEntry,
    capture: MemberInputCapture,
    current: () => boolean
  ): TeamMcpGroupPort | undefined;
  crossTeam?(entry: MemberEntry, isCurrent: () => boolean): TeamMcpCrossTeamPort | undefined;
  workSync?(
    entry: MemberEntry,
    captureSource: MemberInputCapture,
    delivery: NonNullable<NativeWorkSyncMemberContext['delivery']>
  ): ReturnType<ReturnType<typeof createHostWorkSyncComposition>['member']> | undefined;
  settleDeliveries(entry: MemberEntry, assertOriginal: () => void): Promise<void>;
  nativeCreation?(
    entry: MemberEntry,
    captureSource: MemberInputCapture
  ): TeamMcpNativeMemberCreationPort;
  nativeActions?(
    entry: MemberEntry,
    captureSource: MemberInputCapture
  ): TeamMcpNativeMemberActionPort;
  isSealed(): boolean;
  beforeTeamAuthority?(entry: MemberEntry): void;
  assertCurrent(entry: MemberEntry): void;
  captureInteractions(entry: MemberEntry): void;
  readRuntime: RuntimeOwner['readCapturedSession'];
  readCheckpoint: RuntimeOwner['readCheckpoint'];
  observe: RuntimeOwner['observeProviderActivity'];
  onProgress(entry: MemberEntry): void;
}): RuntimeOwnerOptions['driverFactory'] {
  const beforeTeamAuthority = options.beforeTeamAuthority;
  return {
    open: async (request, assertAllocation) => {
      const config = {
        tenantId: request.tenantId,
        projectId: request.projectId,
        sessionId: request.sessionId,
        generation: request.generation,
        configRevision: request.configRevision,
        requiredCapabilities: request.requiredCapabilities,
      };
      const entry = [...options.entries.values()].find(
        (candidate) => runtimeDigest(candidate.config) === runtimeDigest(config)
      );
      if (!entry || options.isSealed() || entry.provider || !assertAllocation)
        throw new RuntimeOwnerError('hold');
      // A selected V2 member must never fall through to the legacy V1 provider.
      // The owned embedded engine is selected by trusted composition only.
      // Other V2 execution surfaces still require an explicitly injected owner.
      if (entry.profile.provider === 'opencode' &&
          entry.profile.nativeGeneration === 'v2' && !options.createProvider &&
          !(entry.profile.protocolRevision === '2.1.4' && entry.profile.embedded))
        throw new RuntimeOwnerError('hold');
      const authority = captureMemberProviderAuthority({
        entry,
        request,
        profileId: options.profileId,
        hostIncarnation: options.hostIncarnation,
        assertAllocation,
        ...(beforeTeamAuthority ? { beforeTeamAuthority: () => beforeTeamAuthority(entry) } : {}),
        assertCurrent: () => options.assertCurrent(entry),
        readRuntime: () => options.readRuntime(entry.binding),
      });
      authority.assertCurrent();
      await assertRuntimeWorktree(entry);
      authority.assertCurrent();
      assertAllocation();
      const readiness = (() => {
        if (entry.profile.provider !== 'opencode') return undefined;
        const launch = options.readinessLaunch?.(entry);
        if (!launch) throw new RuntimeOwnerError('hold');
        return consumeMemberModelReadiness({ ...(options.modelReadiness ? { management: options.modelReadiness } : {}),
          launch, entry, hostIncarnation: options.hostIncarnation,
          assertCurrent: () => { authority.assertCurrent(); assertAllocation(); } });
      })();
      const setupCurrent = () => {
        try {
          if (!authority.isCurrent()) return false;
          const state = options.readRuntime(entry.binding);
          if (state.record?.phase === 'opening' && !state.attached) readiness?.assertCurrent();
          return true;
        } catch { return false; }
      };
      const canAllocate = () => authority.canAllocate() && setupCurrent();
      entry.endpointExpiresAtMs = Date.now() + (entry.profile.mcpLifetimeMs ?? 24 * 60 * 60 * 1000);
      // Input capture always belongs to this immutable target, never the lead that created it.
      const binding = structuredClone(entry.binding),
        delivery = structuredClone(entry.delivery),
        capturedConfig = structuredClone(request),
        owner = entry.team.owner,
        principalId = entry.profile.principalId;
      const captureSource: MemberInputCapture = (requireLead = false) =>
        captureNativeInputAuthority({
          binding,
          profileId: options.profileId,
          hostIncarnation: options.hostIncarnation,
          config: capturedConfig,
          readRuntime: () => options.readRuntime(binding),
          captureTeam: (raw) =>
            owner.captureNativeMcpAuthority(principalId, delivery, raw, requireLead),
          assertCurrent: authority.assertCurrent,
        });
      const groups = options.groups?.(entry, captureSource, authority.isCurrent);
      const crossTeam = options.crossTeam?.(entry, authority.isCurrent),
        workSync = options.workSync?.(entry, captureSource, {
          principalId,
          readRuntime: () => options.readRuntime(binding),
          captureTeam: (raw) => owner.captureNativeMcpAuthority(principalId, delivery, raw, false),
          assertCurrent: authority.assertCurrent,
          settleDeliveries: async () => {
            authority.assertCurrent();
            await options.settleDeliveries(entry, authority.assertCurrent);
            authority.assertCurrent();
          },
        }),
        nativeMemberActions = options.nativeActions?.(entry, captureSource),
        nativeMemberCreation = options.nativeCreation?.(entry, captureSource);
      if (workSync) entry.settleWorkSync = workSync.settleAccepted;
      const connection = {
        ...owner.connect(principalId),
        ...(groups ? { groups } : {}),
        ...(crossTeam ? { crossTeam } : {}),
        ...(workSync ? { workSync } : {}),
        ...(nativeMemberActions ? { nativeMemberActions } : {}),
        ...(nativeMemberCreation ? { nativeMemberCreation } : {}),
        process: createMemberProcessMcpPort({
          entry,
          ...(options.processCustody ? { native: options.processCustody } : {}),
          assertCurrent: authority.assertCurrent,
          assertAllocatedCurrent: authority.assertAllocatedCurrent,
          captureSource,
        }),
      };
      const endpoint = await startTeamMcpEndpoint({
        connection,
        binding: delivery,
        expiresAtMs: entry.endpointExpiresAtMs,
        isCurrentBinding: readiness ? canAllocate : authority.canAllocate,
      });
      entry.endpoint = endpoint;
      try {
        if (readiness) {
          readiness.assertCurrent();
        } else {
          authority.assertCurrent();
          assertAllocation();
        }
        const selected = entry.team.definition.members.find(
          (candidate) => candidate.memberId === binding.memberId
        );
        if (!selected) throw new RuntimeOwnerError('hold');
        const evidence = createMemberEvidenceCapture({
          entry,
          request,
          ownerStorageRoot: options.storageRoot,
          profileId: options.profileId,
          hostIncarnation: options.hostIncarnation,
          principalId: options.principalId,
          windows: options.windows,
          assertCurrent: authority.assertCurrent,
          readRuntime: options.readRuntime,
        });
        const subagents = createClaudeSubagents({
          entry,
          isCurrent: authority.isCurrent,
          readRuntime: options.readRuntime,
          observe: options.observe,
        });
        const attachmentDelivery = createMemberAttachmentPort({
          entry,
          storageRoot: options.storageRoot,
          assertCurrent: authority.assertCurrent,
          readRuntime: options.readRuntime,
        });
        const provider = (
          options.createProvider ??
          (entry.profile.provider === 'claude'
            ? createClaudeMemberProvider
            : entry.profile.provider === 'codex'
              ? createCodexMemberProvider
              : entry.profile.nativeGeneration === 'v2'
                ? createOpenCodeV2EmbeddedMemberProvider
                : createOpenCodeMemberProvider)
        )({
          profile: entry.profile,
          request,
          endpoint,
          connection,
          ...(options.processCustody ? { processCustody: options.processCustody } : {}),
          instructions: memberInitialInstructions(
            selected.name,
            selected.role,
            delivery.teamName,
            entry.profile.cwd
          ),
          ...evidence,
          attachments: attachmentDelivery.port,
          ...(subagents ? { subagents } : {}),
          isCurrent: authority.isCurrent,
          canAllocate: readiness ? canAllocate : authority.canAllocate,
          ...(readiness?.kind === 'preparation' && readiness.assertReadinessCredential
            ? { assertReadinessCredential: readiness.assertReadinessCredential } : {}),
          canCaptureRegisteredProcess: authority.isCurrent,
          readCheckpoint: options.readCheckpoint,
          ...(entry.profile.provider === 'claude' && request.checkpointRef !== undefined ? {
            readCheckpointSource: createClaudeCheckpointSource({
              entry, request, profileId: options.profileId, hostIncarnation: options.hostIncarnation,
              readRuntime: options.readRuntime, assertCurrent: authority.assertCurrent, assertAllocation,
            }),
          } : {}),
          onProgress: () => options.onProgress(entry),
        });
        options.captureInteractions(entry);
        entry.provider = provider;
        const opened = await provider.factory.open(request);
        const source = opened.driver;
        return {
          ...opened,
          driver: {
            sessionRef: source.sessionRef,
            submit: (input) => source.submit(attachmentDelivery.prepareInput(input)),
            observe: () => source.observe(),
            respondToInteraction: (reference, reply) =>
              source.respondToInteraction(reference, reply),
            interrupt: (operation) => source.interrupt(operation),
            checkReadiness: () => source.checkReadiness(),
            checkpoint: () => source.checkpoint(),
            close: () => source.close(),
          },
        };
      } catch (error) {
        endpoint.revoke();
        await endpoint.close();
        throw error;
      }
    },
  };
}
