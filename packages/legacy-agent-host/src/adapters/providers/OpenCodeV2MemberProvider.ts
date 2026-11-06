import { createOpenCodeV2DriverFactory } from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeV2DriverConfig } from '@agent-teams/provider-implementations/opencode';
import { runtimeDigest } from '../../runtime/identity.js';
import { initialContextDigest } from '../../team-launch/context.js';
import type { NativeContextEvidence } from '../../team-launch/contracts.js';
import { preflightOpenCodeV2EffectiveExternalDirectory } from '../../composition/openCodeV2StaticPreflight.js';
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
  /**
   * Fresh readback from the ACTUAL running native executable, not the npm
   * wrapper, an archive digest, or a cached profile. The owner must measure
   * the process's executable bytes and PID/start identity on every probe.
   * Missing or changed evidence makes this capture permanently unready.
   */
  readNativeCustody(signal: AbortSignal): Promise<Readonly<{
    executablePath: string;
    executableSha256: string;
    pid: number;
    startIdentity: string;
    version: string;
  }> | undefined>;
  /**
   * Read back the fully assembled rules from THIS owned native engine, not a
   * user config fragment. The owner must prove the same PID/start identity.
   */
  readNativeEffectivePermissions(signal: AbortSignal): Promise<unknown>;
  /** Captured product policy; V2's permissive default is never inherited. */
  readonly requiredExternalDirectory: 'ask' | 'deny';
  /**
   * Install exact launch instructions in THIS native session and read back
   * identity-bound confirmation. Must not replay a mutation after lost ACK.
   * Without a real native implementation this contract remains HOLD.
   */
  installAndAttestInitialContext(
    capture: Readonly<{ nativeSessionId: string; instructions: string; contextDigest: string;
      generation: string; configRevision: string }>,
    signal: AbortSignal
  ): Promise<Readonly<{ nativeSessionId: string; contextDigest: string;
    generation: string; configRevision: string }> | undefined>;
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

  // Capture the required product policy ONCE. A mutable owner object must
  // never turn an original external-directory deny into a later ask.
  const requiredExternalDirectory = owned.requiredExternalDirectory;
  if (requiredExternalDirectory !== 'ask' && requiredExternalDirectory !== 'deny')
    throw new Error('OpenCode V2 requires a captured out-of-project policy');
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
  // A failed re-attestation permanently revokes this native capture. A later
  // reconfiguration cannot silently restore previously granted authority.
  let qualificationRevoked = false;
  let wasEverReady = false;
  let pinnedProcessIdentity: Readonly<{ pid: number; startIdentity: string }> | undefined;
  let stopAttempt: Promise<boolean> | undefined;
  let checking: Promise<boolean> | undefined;
  // Re-attestation may temporarily fence readiness without revoking Host authority.
  // Existing observers must wait for a definitive result, not drop native events.
  const pendingReattestations = new Set<Promise<void>>();
  let physicallyStopped = false;
  let initialEvidence: NativeContextEvidence | undefined;
  // Installation may have taken effect even if its ACK was lost. Keep one
  // attempt for this owned session and never replay the native mutation.
  let initialContextAttempt: ReturnType<OpenCodeV2OwnedSession['installAndAttestInitialContext']> | undefined;
  const contextDigest = initialContextDigest(context.instructions);
  const abort = new AbortController();

  const current = () => {
    if (sealed || qualificationRevoked) return false;
    if (context.isCurrent() && context.canAllocate()) return true;
    // A temporarily lost Host authority is not a renewable V2 lease.
    // Latch revocation even if allocation becomes available again before
    // the next asynchronous native readiness check.
    qualificationRevoked = true;
    ready = false;
    initialEvidence = undefined;
    abort.abort();
    // This is the captured TEST-owned process only. finishOwned deduplicates
    // the stop attempt and allows read-only confirmation after an unknown ACK.
    void finishOwned();
    return false;
  };
  const finishOwned = async (): Promise<boolean> => {
    sealed = true;
    ready = false;
    initialEvidence = undefined;
    abort.abort();
    // A stop with an uncertain ACK is never submitted twice. Subsequent
    // cleanup checks may ONLY read physical status for this same owned PID.
    stopAttempt ??= Promise.resolve().then(() => owned.stopOwned()).catch(() => false);
    await stopAttempt;
    if (physicallyStopped) return true;
    checking ??= Promise.resolve().then(() => owned.confirmStopped())
      .catch(() => false)
      .then((stopped) => {
        if (stopped) physicallyStopped = true;
        return stopped;
      })
      .finally(() => { checking = undefined; });
    return checking;
  };

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
          if (qualificationRevoked) return false;
          const reattestation = Promise.withResolvers<void>();
          pendingReattestations.add(reattestation.promise);
          // Even an already-aborted check, or a temporarily lost Host lease,
          // invalidates old readiness before any early return.
          ready = false;
          initialEvidence = undefined;
          let accepted = false;
          try {
            if (!current() || signal.aborted) return false;
            const combined = AbortSignal.any([signal, abort.signal]);
            const valid = await owned.probe(combined);
            if (!valid || combined.aborted || !current()) return false;
            // This is an independently captured, immutable Host process pin.
            // A loopback HTTP success or a wrapper/package hash is not native
            // custody. Even identical bytes in a restarted PID cannot inherit
            // the old member's authority without a new Host capture.
            const custody = await owned.readNativeCustody(combined);
            if (!custody || combined.aborted || !current() ||
                custody.executablePath !== profile.executable.path ||
                custody.executableSha256 !== profile.executable.sha256 ||
                custody.version !== profile.protocolRevision ||
                !Number.isSafeInteger(custody.pid) || custody.pid <= 0 ||
                typeof custody.startIdentity !== 'string' ||
                !/^[A-Za-z0-9._:-]{1,128}$/.test(custody.startIdentity) ||
                (pinnedProcessIdentity !== undefined &&
                  (custody.pid !== pinnedProcessIdentity.pid ||
                   custody.startIdentity !== pinnedProcessIdentity.startIdentity))) return false;
            pinnedProcessIdentity ??= { pid: custody.pid, startIdentity: custody.startIdentity };
            // Source-only candidate plus owner-supplied native readback. The
            // production owner still must prove genuine engine custody and
            // cannot claim qualification from a scripted TEST receipt.
            const effective = await owned.readNativeEffectivePermissions(combined);
            const policy = preflightOpenCodeV2EffectiveExternalDirectory(
              effective, requiredExternalDirectory);
            if (policy.kind !== 'policy-candidate' || combined.aborted || !current()) return false;
            // A native session being reachable is NOT a ready Team member.
            // Initial role/team/workspace instructions need native readback;
            // never infer their installation from probe or a local digest.
            initialContextAttempt ??= Promise.resolve().then(() => {
              if (combined.aborted || !current()) return undefined;
              return owned.installAndAttestInitialContext(Object.freeze({
                nativeSessionId: profile.nativeSessionId!,
                instructions: context.instructions,
                contextDigest,
                generation: context.endpoint.binding.generation,
                configRevision: context.request.configRevision,
              }), combined);
            });
            const attested = await initialContextAttempt;
            if (!attested || combined.aborted || !current() ||
                attested.nativeSessionId !== profile.nativeSessionId ||
                attested.contextDigest !== contextDigest ||
                attested.generation !== context.endpoint.binding.generation ||
                attested.configRevision !== context.request.configRevision) return false;
            // A process or policy may change during the initial native PUT.
            // Re-attest both after the mutation; never retry a lost PUT ACK.
            const finalEffective = await owned.readNativeEffectivePermissions(combined);
            if (preflightOpenCodeV2EffectiveExternalDirectory(
              finalEffective, requiredExternalDirectory).kind !== 'policy-candidate' ||
                combined.aborted || !current()) return false;
            const finalCustody = await owned.readNativeCustody(combined);
            if (!finalCustody || combined.aborted || !current() ||
                finalCustody.executablePath !== custody.executablePath ||
                finalCustody.executableSha256 !== custody.executableSha256 ||
                finalCustody.version !== custody.version ||
                finalCustody.pid !== custody.pid ||
                finalCustody.startIdentity !== custody.startIdentity) return false;
            initialEvidence = {
              kind: 'native-configuration', contextDigest,
              generation: context.endpoint.binding.generation,
              configRevision: context.request.configRevision,
            };
            ready = true;
            context.onProgress();
            wasEverReady = true;
            accepted = true;
            return true;
          } finally {
            try {
              if (!accepted) {
                qualificationRevoked = true;
                ready = false;
                initialEvidence = undefined;
                abort.abort();
                // A previously live member must not leave the loosened native
                // process running while Host reports an unready session.
                // Only its captured owner may perform this physical stop.
                if (wasEverReady) await finishOwned();
              }
            } finally {
              pendingReattestations.delete(reattestation.promise);
              reattestation.resolve();
            }
          }
        },
        // D.close() must report physical cleanup. Once shutdown begins,
        // there is no second submission even after uncertain ACK.
        confirmStopped: finishOwned,
      };
    },
  });

  return {
    // The standard Host retains the provider after constructing it, but a
    // failed D.open may reject before it returns a driver/close receipt.
    // Retire this capture immediately; the outer Runtime must not assume the
    // original failed allocation is free to retry or reuse a V1 session.
    factory: {
      async open(request) {
        try {
          const opened = await factory.open(request);
          const source = opened.driver;
          return {
            ...opened,
            driver: {
              sessionRef: source.sessionRef,
              // A preflight failure inside the private V2 turn driver seals its
              // own session, but does not call Host.seal(). Do not leave the
              // Host reporting an authorized native process after its SPI has
              // become unavailable. Only retire on terminal transport failure,
              // never on validation/backpressure/stale-input replies.
              submit: async (input) => {
                // A leaked session handle must not submit after the Host
                // revokes its generation/lease or seals the owned process.
                const authorized = current();
                if (!ready || !authorized) {
                  // A concurrent native re-attestation makes ready transiently false.
                  // Fence this operation, but never stop a healthy owned PID unless
                  // its actual Host authority has been revoked.
                  if (!authorized && !await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const,
                  code: 'unavailable' as const, delivery: 'known-not-sent' as const };
                }
                let reply: Awaited<ReturnType<typeof source.submit>>;
                try {
                  reply = await source.submit(input);
                } catch (error) {
                  const stopped = await finishOwned();
                  if (!stopped) throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
                  throw error;
                }
                if (!reply.ok && (reply.code === 'dependency-unavailable' ||
                    reply.code === 'unavailable' || reply.code === 'unknown')) {
                  // Input delivery was known-not-sent, but native process
                  // termination is a separate UNKNOWN fact. Surface that
                  // custody failure explicitly instead of falsifying the
                  // input result, and never repeat the physical stop signal.
                  if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                }
                return reply;
              },
              // An ended private feed means the Session SPI has sealed or
              // closed. Do not keep a previously captured Host admission alive.
              // Consumer-initiated early iterator return is not evidence of a
              // native failure, so only natural exhaustion/error retires it.
              observe: async function* () {
                // The private EventFeed deliberately drains buffered events
                // after end(). That is safe for its own Session semantics, but
                // must NOT leak events across a revoked Host generation.
                const iterator = source.observe()[Symbol.asyncIterator]();
                let wakeRevocation!: () => void;
                const revoked = new Promise<void>((resolve) => { wakeRevocation = resolve; });
                const onAbort = () => wakeRevocation();
                abort.signal.addEventListener('abort', onAbort, { once: true });
                if (abort.signal.aborted) onAbort();
                let exhausted = false;
                let authorityLost = false;
                const waitForAttestation = async (): Promise<boolean> => {
                  while (current()) {
                    if (ready && pendingReattestations.size === 0) return true;
                    const checks = [...pendingReattestations];
                    if (checks.length === 0) return false;
                    // A temporary recheck fences events but cannot consume or
                    // terminate the single private EventFeed observer.
                    await Promise.race([Promise.all(checks), revoked]);
                  }
                  return false;
                };
                try {
                  for (;;) {
                    if (!await waitForAttestation()) {
                      authorityLost = true;
                      break;
                    }
                    // Do not strand a Host observer waiting on EventFeed.next()
                    // when seal/lease loss occurs with no further native event.
                    const outcome = await Promise.race([
                      iterator.next().then(value => ({ kind: 'event' as const, value })),
                      revoked.then(() => ({ kind: 'revoked' as const })),
                    ]);
                    // Authority must be checked AFTER awaiting next(): EventFeed
                    // may already have queued a native event before revocation.
                    if (outcome.kind === 'revoked' || !current()) {
                      authorityLost = true;
                      break;
                    }
                    if (outcome.value.done) { exhausted = true; break; }
                    // A native event may arrive while a probe is pending.
                    // Retain it until the same owned PID, policy, and context
                    // have been successfully re-attested; never leak on loss.
                    if (!await waitForAttestation()) {
                      authorityLost = true;
                      break;
                    }
                    yield outcome.value.value;
                  }
                } catch (error) {
                  if (!await finishOwned())
                    throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
                  throw error;
                } finally {
                  abort.signal.removeEventListener('abort', onAbort);
                  try {
                    // The pinned EventFeed does not accept cancellation. On
                    // revocation its pending next() must be woken by closing
                    // the captured private session, before returning its inner
                    // iterator. close() uses the existing single-flight owner
                    // stop/confirmation and never replays a native mutation.
                    if (authorityLost) await source.close();
                    // Consumer return occurs between yields, so it needs no
                    // native process stop. Always release the inner iterator.
                    await iterator.return?.();
                  } finally {
                    if ((authorityLost || exhausted) && !await finishOwned())
                      throw new Error('opencode.v2.owner-cleanup-unknown');
                  }
                }
              },
              respondToInteraction: async (reference, reply) => {
                // V2 permission replies are native mutations. Never let a
                // retained driver handle grant after Host seal/lease loss.
                const authorized = current();
                if (!ready || !authorized) {
                  // A concurrent native re-attestation makes ready transiently false.
                  // Fence this operation, but never stop a healthy owned PID unless
                  // its actual Host authority has been revoked.
                  if (!authorized && !await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const, code: 'unavailable' as const };
                }
                try {
                  const result = await source.respondToInteraction(reference, reply);
                  if (!result.ok && (result.code === 'unknown' || result.code === 'unavailable'))
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return result;
                } catch (error) {
                  if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
                  throw error;
                }
              },
              interrupt: async (operation) => {
                const authorized = current();
                if (!ready || !authorized) {
                  // A concurrent native re-attestation makes ready transiently false.
                  // Fence this operation, but never stop a healthy owned PID unless
                  // its actual Host authority has been revoked.
                  if (!authorized && !await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const, code: 'unavailable' as const };
                }
                try {
                  const result = await source.interrupt(operation);
                  if (!result.ok && (result.code === 'unknown' || result.code === 'unavailable'))
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return result;
                } catch (error) {
                  if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
                  throw error;
                }
              },
              checkReadiness: async () => {
                const authorized = current();
                if (!ready || !authorized) {
                  // A concurrent native re-attestation makes ready transiently false.
                  // Fence this operation, but never stop a healthy owned PID unless
                  // its actual Host authority has been revoked.
                  if (!authorized && !await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const, code: 'unavailable' as const };
                }
                try {
                  const result = await source.checkReadiness();
                  if (!result.ok) {
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  }
                  return result;
                } catch (error) {
                  if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
                  throw error;
                }
              },
              checkpoint: () => ready && current() ? source.checkpoint() :
                { ok: false as const, code: 'unavailable' as const },
              close: () => {
                ready = false;
                initialEvidence = undefined;
                return source.close();
              },
            },
          };
        } catch (error) {
          const stopped = await finishOwned();
          if (!stopped) throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
          throw error;
        }
      },
    },
    isReady: () => ready && current(),
    initialContextEvidence: () => ready && current() ? initialEvidence : undefined,
    seal: () => {
      sealed = true;
      ready = false;
      initialEvidence = undefined;
      abort.abort();
      // Sealing revokes native custody immediately, even if the caller has
      // not yet reached its asynchronous cleanup phase. finishOwned retains
      // the single-stop/physical-confirmation discipline.
      void finishOwned();
    },
    cleanup: finishOwned,
  };
}
