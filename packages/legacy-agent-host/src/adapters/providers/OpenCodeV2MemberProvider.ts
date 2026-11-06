import { createOpenCodeV2DriverFactory } from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeV2DriverConfig } from '@agent-teams/provider-implementations/opencode';
import { runtimeDigest } from '../../runtime/identity.js';
import type { MemberProvider, MemberProviderContext } from './MemberProvider.js';

/**
 * A separately selected, TEST-owned native V2 engine and session. The provider
 * does not launch a shared CLI, adopt a V1 session, read user configs, or
 * manufacture a process identity. The owner must prove its actual engine
 * executable, PID/start identity, effective permissions, MCP and isolation.
 *
 * This contract is not a production owner implementation. In particular,
 * provider factory openness does not qualify Desktop's 2.1.4 distribution.
 */
export interface OpenCodeV2OwnedSession {
  readPassword(): string;
  probe(signal: AbortSignal): Promise<boolean>;
  /** Stop ONLY this capture's process tree, never a user/shared V1 process. */
  stopOwned(): Promise<boolean>;
  /** Confirm physical termination of the same PID/start identity. */
  confirmStopped(): Promise<boolean>;
}

/**
 * Stage1's existing Session SPI, with a completely separate V2 adapter.
 * Only a private, explicitly injected generation-selected composition may
 * supply the owned session. The default Host still refuses V2 allocation.
 */
export function createOpenCodeV2MemberProvider(
  context: MemberProviderContext,
  owned: OpenCodeV2OwnedSession
): MemberProvider {
  const selected = context.profile;
  if (selected.provider !== 'opencode' || selected.nativeGeneration !== 'v2' ||
      (selected.protocolRevision !== '2.0.0' && selected.protocolRevision !== '2.0.21') ||
      !selected.nativeSessionId || selected.mcpPolicyPlugin ||
      selected.capturedMcpServers || selected.nativeOptions.toolApprovalMode !== undefined ||
      (selected.extraArgs?.length ?? 0) !== 0)
    throw new Error('OpenCode V2 requires a separate native profile and owner');

  // This is the exact trusted Host selection. It is never a renderer/Runtime
  // argument and must not be inferred from model ID or an executable on PATH.
  const profile = structuredClone(selected);
  const originalRequest = runtimeDigest(context.request);
  const trustedBinding = runtimeDigest({
    binding: context.endpoint.binding,
    memberId: profile.memberId,
    sessionId: profile.sessionId,
    generation: profile.generation,
  });
  let sealed = false;
  let allocated = false;
  let ready = false;
  let closing: Promise<boolean> | undefined;

  const current = () => !sealed && context.isCurrent() && context.canAllocate();
  const finishOwned = () => (closing ??= (async () => {
    sealed = true;
    ready = false;
    try {
      if (!(await owned.stopOwned())) return false;
      return await owned.confirmStopped();
    } catch {
      return false;
    }
  })());

  const factory = createOpenCodeV2DriverFactory({
    capabilities: ['text', 'tools', 'permission', 'interrupt', 'checkpoint'],
    readCheckpoint: (reference, request) => context.readCheckpoint(reference, request),
    resolveConfiguration: async (request): Promise<OpenCodeV2DriverConfig | undefined> => {
      if (allocated || !current() || runtimeDigest(request) !== originalRequest) return undefined;
      // The private D driver checks checkpoint identity BEFORE a native probe.
      // No createSession, implicit V1 resume or retry occurs in this adapter.
      allocated = true;
      return {
        endpoint: profile.endpoint,
        directory: profile.cwd,
        nativeSessionId: profile.nativeSessionId!,
        version: profile.protocolRevision as '2.0.0' | '2.0.21',
        configRevision: profile.configRevision,
        trustedBinding,
        accountBinding: profile.accountBinding,
        binding: {
          tenantId: request.tenantId,
          projectId: request.projectId,
          sessionId: request.sessionId,
          generation: request.generation,
        },
        limits: profile.limits,
        readPassword: () => {
          if (!current()) throw new Error('V2 native custody revoked');
          return owned.readPassword();
        },
        probe: async (signal) => {
          if (!current() || signal.aborted) return false;
          const valid = await owned.probe(signal);
          ready = valid && !signal.aborted && current();
          if (ready) context.onProgress();
          return ready;
        },
        // D.close() must report physical cleanup. Once shutdown begins,
        // there is no second submission even after uncertain ACK.
        confirmStopped: finishOwned,
      };
    },
  });

  return {
    factory,
    isReady: () => ready && current(),
    seal: () => {
      sealed = true;
      ready = false;
    },
    cleanup: finishOwned,
  };
}
