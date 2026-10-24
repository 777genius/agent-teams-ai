import { createMemberAttachmentPort } from './createMemberAttachmentPort.js';
import type { TeamMcpNativeMemberCreationPort } from '../mcp/nativeMemberCreationContracts.js';
import { createClaudeMemberProvider } from '../adapters/providers/ClaudeMemberProvider.js';
import { createCodexMemberProvider } from '../adapters/providers/CodexMemberProvider.js';
import { createOpenCodeMemberProvider } from '../adapters/providers/OpenCodeMemberProvider.js';
import { startTeamMcpEndpoint } from '../mcp/endpoint.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { captureMemberProviderAuthority } from './captureMemberProviderAuthority.js';
import { captureNativeInputAuthority } from './captureNativeInputAuthority.js';
import { createClaudeSubagents } from './createClaudeSubagents.js';
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
  processCustody?: ProcessCustody;
  createProvider?(context: MemberProviderContext): MemberProvider;
  crossTeam?(entry: MemberEntry, isCurrent: () => boolean): TeamMcpCrossTeamPort | undefined;
  workSync?(
    entry: MemberEntry,
    captureSource: MemberInputCapture,
    delivery: NonNullable<NativeWorkSyncMemberContext['delivery']>
  ): ReturnType<ReturnType<typeof createHostWorkSyncComposition>['member']> | undefined;
  settleDeliveries(entry: MemberEntry, assertOriginal: () => void): Promise<void>;
  nativeCreation?(entry: MemberEntry, captureSource: MemberInputCapture): TeamMcpNativeMemberCreationPort;
  nativeActions?(
    entry: MemberEntry,
    captureSource: MemberInputCapture
  ): TeamMcpNativeMemberActionPort;
  isSealed(): boolean;
  assertCurrent(entry: MemberEntry): void;
  captureInteractions(entry: MemberEntry): void;
  readRuntime: RuntimeOwner['readCapturedSession'];
  readCheckpoint: RuntimeOwner['readCheckpoint'];
  observe: RuntimeOwner['observeProviderActivity'];
  onProgress(): void;
}): RuntimeOwnerOptions['driverFactory'] {
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
      const authority = captureMemberProviderAuthority({
        entry,
        request,
        profileId: options.profileId,
        hostIncarnation: options.hostIncarnation,
        assertAllocation,
        assertCurrent: () => options.assertCurrent(entry),
        readRuntime: () => options.readRuntime(entry.binding),
      });
      authority.assertCurrent();
      await assertRuntimeWorktree(entry);
      authority.assertCurrent();
      assertAllocation();
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
        isCurrentBinding: authority.canAllocate,
      });
      entry.endpoint = endpoint;
      try {
        authority.assertCurrent();
        assertAllocation();
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
        const provider = (
          options.createProvider ??
          (entry.profile.provider === 'claude'
            ? createClaudeMemberProvider
            : entry.profile.provider === 'codex'
              ? createCodexMemberProvider
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
          attachments: createMemberAttachmentPort({ entry, storageRoot: options.storageRoot, assertCurrent: authority.assertCurrent, readRuntime: options.readRuntime }),
          ...(subagents ? { subagents } : {}),
          isCurrent: authority.isCurrent,
          canAllocate: authority.canAllocate,
          canCaptureRegisteredProcess: authority.isCurrent,
          readCheckpoint: options.readCheckpoint,
          onProgress: options.onProgress,
        });
        options.captureInteractions(entry);
        entry.provider = provider;
        return await provider.factory.open(request);
      } catch (error) {
        endpoint.revoke();
        await endpoint.close();
        throw error;
      }
    },
  };
}
