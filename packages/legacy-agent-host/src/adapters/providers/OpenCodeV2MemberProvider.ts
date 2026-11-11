import { createOpenCodeV2DriverFactory } from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeV2DriverConfig } from '@agent-teams/provider-implementations/opencode';
import { types as nodeUtilTypes } from 'node:util';
import { snapshotOpenCodeV2PermissionReadback } from './OpenCodeV2PermissionReadback.js';
import { snapshotOpenCodeV2CustodyReadback } from './OpenCodeV2CustodyReadback.js';
import { snapshotOpenCodeV2InitialContextReadback } from './OpenCodeV2InitialContextReadback.js';
import { runtimeDigest } from '../../runtime/identity.js';
import { finalizeOpenCodeV2ObserverAfterClose, guardOpenCodeV2ObserverCleanup } from './OpenCodeV2ObserverCleanup.js';
import { initialContextDigest } from '../../team-launch/context.js';
import type { NativeContextEvidence } from '../../team-launch/contracts.js';
import { preflightOpenCodeV2EffectiveExternalDirectory } from '../../composition/openCodeV2StaticPreflight.js';
import { hasUntrustedOpenCodeBinaryOverride } from '../../composition/openCodeV2Environment.js';
import { waitForNativeStopResult } from './OpenCodeV2StopAckWait.js';
import { awaitOpenCodeV2OwnerReadback } from './OpenCodeV2OwnerReadback.js';
import type { MemberProvider, MemberProviderContext } from './MemberProvider.js';
// The native executable witness must be a canonical SHA-256, not merely two
// equal strings supplied by a malformed private selection and owner.
const nativeSha256Hex = /^[a-f0-9]{64}$/;
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
   * Read back fully assembled rules from THIS owned native engine and
   * session, not a user config fragment. Bind the readback to the real PID
   * and start identity, not just the credentials or loopback address.
   */
  readNativeEffectivePermissions(signal: AbortSignal): Promise<Readonly<{
    nativeSessionId: string;
    pid: number;
    startIdentity: string;
    rules: unknown;
  }> | undefined>;
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
 * Capture native owner and Host authority callbacks from data descriptors
 * without executing accessors or function metadata getters. Prototype
 * methods retain their original receiver.
 */
function captureDataCallback<T extends object, K extends keyof T>(
  receiver: T, name: K, callbackOwner: 'native owner' | 'Host authority' = 'native owner'
): T[K] {
  let prototype: object | null = receiver;
  while (prototype !== null) {
    // A Proxy's descriptor/prototype traps can swap later custody callbacks
    // before they are captured, laundering an unsafe native permission reader.
    // Test every chain element before any reflective operation on it.
    if (nodeUtilTypes.isProxy(prototype))
      throw new Error(`OpenCode V2 requires data-property ${callbackOwner} callbacks`);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor) {
      if (typeof descriptor.value !== 'function' || nodeUtilTypes.isProxy(descriptor.value))
        throw new Error(`OpenCode V2 requires data-property ${callbackOwner} callbacks`);
      // A Proxy-wrapped function can counterfeit a Host lease or a native
      // permission/custody result through its apply trap. Such callbacks are
      // not ordinary captured data-method identities.
      // Function.prototype.bind reads target.name and target.length. Those
      // getters can replace another authority callback during capture.
      // Reflect.apply preserves original identity/receiver without metadata reads.
      const original = descriptor.value as (...args: unknown[]) => unknown;
      return ((...args: unknown[]) => Reflect.apply(original, receiver, args)) as unknown as T[K];
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  throw new Error(`OpenCode V2 requires data-property ${callbackOwner} callbacks`);
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
  // Capture Host identity BEFORE consulting the mutable native owner.
  // A policy property getter must never relabel an already validated lease.
  const originalRequest = runtimeDigest(context.request);
  const originalEndpointBinding = runtimeDigest(context.endpoint.binding);
  const originalProfile = runtimeDigest(context.profile);
  const capturedInstructions = context.instructions;
  // Retain original Host authority before a native owner getter can swap
  // these callbacks. Binding via Function.prototype.bind itself invokes
  // attacker-controlled .name/.length getters during capture.
  const capturedIsCurrent = captureDataCallback(context, 'isCurrent', 'Host authority');
  const capturedCanAllocate = captureDataCallback(context, 'canAllocate', 'Host authority');
  // Preserve the selected Host storage/progress callbacks across native
  // policy getters, native probes and async checkpoint reads.
  const capturedReadCheckpoint = captureDataCallback(context, 'readCheckpoint', 'Host authority');
  const capturedOnProgress = captureDataCallback(context, 'onProgress', 'Host authority');
  const selected = structuredClone(context.profile);
  // A trusted profile alone cannot sanitize an override inherited from
  // the parent Host process. Refuse V2 before any TEST owner access.
  const inheritedBinaryOverride = () => hasUntrustedOpenCodeBinaryOverride(process.env);
  if (selected.provider !== 'opencode' || selected.nativeGeneration !== 'v2' ||
      (selected.protocolRevision !== '2.0.0' && selected.protocolRevision !== '2.0.21') ||
      // The private owner is selected for one immutable Host allocation. Reject
      // cross-session, cross-generation or foreign MCP endpoint captures before
      // even reading TEST-owned credentials or starting a native probe.
      selected.sessionId !== context.request.sessionId ||
      selected.generation !== context.request.generation ||
      selected.configRevision !== context.request.configRevision ||
      selected.teamId !== context.endpoint.binding.teamId ||
      selected.memberId !== context.endpoint.binding.memberId ||
      !selected.nativeSessionId || typeof selected.executable.sha256 !== 'string' ||
      !nativeSha256Hex.test(selected.executable.sha256) ||
       hasUntrustedOpenCodeBinaryOverride(selected.environment) ||
      inheritedBinaryOverride() ||
      selected.mcpPolicyPlugin ||
      selected.capturedMcpServers || selected.capturedMcpSource ||
      selected.mcpCatalogSource || // The saved V2 role/workflow instructions live separately from the
      // generic Host context. Until both are installed and natively attested,
      // refuse launch rather than silently dropping captured policy.
      (selected.nativeOptions.instructions?.length ?? 0) !== 0 ||
      selected.nativeOptions.toolApprovalMode !== undefined ||
      (selected.extraArgs?.length ?? 0) !== 0)
    throw new Error('OpenCode V2 requires a separate native profile and owner');

  // Retain TS's discriminated V2 narrowing from the validated selection.
  const profile = selected;

  // Bind original native owner methods BEFORE accessing its policy getter.
  // A policy getter must not be able to replace the effective permission,
  // credential or physical-stop callbacks that this capture will trust.
  // Process custody callbacks are part of the original captured owner. Never
  // look them up again after a native callback could replace the methods and
  // redirect physical cleanup or fabricate a stopped PID.
  // These method identities belong to the original TEST-owned engine. An
  // asynchronous native callback must not replace its custody, permission,
  // instruction or credential reader before the next Host admission check.
  const capturedReadPassword = captureDataCallback(owned, 'readPassword');
  const capturedProbe = captureDataCallback(owned, 'probe');
  const capturedReadNativeCustody = captureDataCallback(owned, 'readNativeCustody');
  const capturedReadNativeEffectivePermissions = captureDataCallback(owned, 'readNativeEffectivePermissions');
  const capturedInstallAndAttestInitialContext = captureDataCallback(owned, 'installAndAttestInitialContext');
  const capturedStopOwned = captureDataCallback(owned, 'stopOwned');
  const capturedConfirmStopped = captureDataCallback(owned, 'confirmStopped');
  // Capture the required product policy ONCE. A mutable owner object must
  // never turn an original external-directory deny into a later ask.
  const requiredExternalDirectory = owned.requiredExternalDirectory;
  if (requiredExternalDirectory !== 'ask' && requiredExternalDirectory !== 'deny')
    throw new Error('OpenCode V2 requires a captured out-of-project policy');
  // An owner policy getter must not make a previously validated Host
  // selection, request, endpoint or instruction capture silently change.
  if (runtimeDigest(context.profile) !== originalProfile ||
      runtimeDigest(context.request) !== originalRequest ||
      runtimeDigest(context.endpoint.binding) !== originalEndpointBinding ||
      context.instructions !== capturedInstructions || inheritedBinaryOverride())
    throw new Error('OpenCode V2 requires an immutable Host capture');
  const capturedGeneration = context.endpoint.binding.generation;
  const capturedConfigRevision = context.request.configRevision;
  // Checkpoint compatibility binds the stable member/session, NOT its
  // ephemeral Host generation or Team runId. The complete endpoint/request
  // snapshots and native PID still fence every live operation to this lease.
  const trustedBinding = runtimeDigest({
    binding: {
      backendId: context.endpoint.binding.backendId,
      teamId: context.endpoint.binding.teamId,
      memberId: context.endpoint.binding.memberId,
    },
    memberId: profile.memberId,
    sessionId: profile.sessionId,
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
  let boundedStopAttempt: Promise<boolean> | undefined;
  let checking: Promise<boolean> | undefined;
  // Re-attestation may temporarily fence readiness without revoking Host authority.
  // Existing observers must wait for a definitive result, not drop native events.
  const pendingReattestations = new Set<Promise<void>>();
  // Do not let a late native mutation ACK inherit a later admission epoch.
  let readinessEpoch = 0;
  let physicallyStopped = false;
  let initialEvidence: NativeContextEvidence | undefined;
  // Installation may have taken effect even if its ACK was lost. Keep one
  // attempt for this owned session and never replay the native mutation.
  let initialContextAttempt: ReturnType<OpenCodeV2OwnedSession['installAndAttestInitialContext']> | undefined;
  const contextDigest = initialContextDigest(capturedInstructions);
  const abort = new AbortController();

  const current = () => {
    if (sealed || qualificationRevoked) return false;
    try {
      // Only literal boolean true is a valid captured Host lease. A Promise,
      // boxed boolean, number or arbitrary truthy object is not authority.
      if (!inheritedBinaryOverride() && capturedIsCurrent() === true &&
          capturedCanAllocate() === true &&
          runtimeDigest(context.request) === originalRequest &&
          runtimeDigest(context.endpoint.binding) === originalEndpointBinding &&
          runtimeDigest(context.profile) === originalProfile &&
          context.instructions === capturedInstructions &&
          !inheritedBinaryOverride()) return true;
    } catch {
      // A failed Host authority callback cannot grant an existing native
      // process another turn. Treat errors as permanent lease revocation,
      // not a transient readiness probe or a recoverable model failure.
    }
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
    stopAttempt ??= Promise.resolve().then(() => capturedStopOwned()).catch(() => false);
    // Keep exactly one original signal even when its ACK never resolves.
    boundedStopAttempt ??= waitForNativeStopResult(stopAttempt);
    await boundedStopAttempt;
    if (physicallyStopped) return true;
    checking ??= waitForNativeStopResult(
      Promise.resolve().then(() => capturedConfirmStopped()).catch(() => false)
    ).then((stopped) => {
        // Only literal true attests physical termination of the pinned PID.
        // Structured native responses cannot become cleanup=confirmed.
        const confirmed = stopped === true;
        if (confirmed) physicallyStopped = true;
        return confirmed;
      })
      .finally(() => { checking = undefined; });
    return checking;
  };

  // A successful probe callback is not yet an admitted Host lease: another
  // native re-attestation can still be in flight, and onProgress can re-enter
  // the public provider before the probe's finally block releases its fence.
  // Never expose readiness, a checkpoint or a native mutation until ALL
  // native readbacks for the captured owner have settled.
  const admissionSettled = () => ready && pendingReattestations.size === 0;

  const factory = createOpenCodeV2DriverFactory({
    capabilities: ['text', 'tools', 'permission', 'interrupt', 'checkpoint'],
    // Checkpoint recovery is a Host storage read. A lease can be revoked in
    // the microtask between V2 config selection and the private D checkpoint
    // lookup; do not disclose even an incompatible checkpoint after revocation.
    readCheckpoint: async (reference, request) => {
      if (!current() || runtimeDigest(request) !== originalRequest)
        throw new Error('OpenCode V2 checkpoint authority revoked');
      const checkpoint = await capturedReadCheckpoint(reference, request);
      if (!current()) throw new Error('OpenCode V2 checkpoint authority revoked');
      return checkpoint;
    },
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
          // Native transports may request credentials after a submit started
          // but while a different Host re-attestation is still unproven.
          // The owner projection itself is also untrusted to preserve the
          // inherited executable environment: recheck AFTER its callback so
          // a synchronous override/revocation cannot authorize a network I/O.
          if (!admissionSettled() || !current())
            throw new Error('V2 native custody revoked');
          const password = capturedReadPassword();
          // A native credential reader must return a primitive string. A boxed
          // or forged value can execute toString() later in the HTTP Basic
          // encoder, after Host authority was checked and before network I/O.
          // Reject blank and control-bearing credentials before ANY native HTTP.
          if (typeof password !== 'string' || password.trim().length === 0 || /[\x00-\x1f\x7f]/.test(password) || !admissionSettled() || !current())
            throw new Error('V2 native custody revoked');
          return password;
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
            const valid = await awaitOpenCodeV2OwnerReadback(() => capturedProbe(combined), combined);
            // A native owner probe must affirm readiness with literal true.
            // Truthy objects or numeric receipts are not native custody proof.
            if (valid !== true || combined.aborted || !current()) return false;
            // This is an independently captured, immutable Host process pin.
            // A loopback HTTP success or a wrapper/package hash is not native
            // custody. Even identical bytes in a restarted PID cannot inherit
            // the old member's authority without a new Host capture.
            const custody = await awaitOpenCodeV2OwnerReadback(() => capturedReadNativeCustody(combined), combined);
            // Native custody is JSON data, never a Proxy or getter-backed
            // identity that can rewrite the next field during admission.
            const admittedCustody = snapshotOpenCodeV2CustodyReadback(custody);
            if (!admittedCustody || combined.aborted || !current() ||
                admittedCustody.executablePath !== profile.executable.path ||
                typeof admittedCustody.executableSha256 !== 'string' ||
                !nativeSha256Hex.test(admittedCustody.executableSha256) ||
                admittedCustody.executableSha256 !== profile.executable.sha256 ||
                admittedCustody.version !== profile.protocolRevision ||
                !Number.isSafeInteger(admittedCustody.pid) || admittedCustody.pid <= 0 ||
                typeof admittedCustody.startIdentity !== 'string' ||
                !/^[A-Za-z0-9._:-]{1,128}$/.test(admittedCustody.startIdentity) ||
                (pinnedProcessIdentity !== undefined &&
                  (admittedCustody.pid !== pinnedProcessIdentity.pid ||
                   admittedCustody.startIdentity !== pinnedProcessIdentity.startIdentity))) return false;
            pinnedProcessIdentity ??= {
              pid: admittedCustody.pid, startIdentity: admittedCustody.startIdentity,
            };
            // Source-only candidate plus owner-supplied native readback. The
            // production owner still must prove genuine engine custody and
            // cannot claim qualification from a scripted TEST receipt.
            const effective = snapshotOpenCodeV2PermissionReadback(
              await awaitOpenCodeV2OwnerReadback(() => capturedReadNativeEffectivePermissions(combined), combined));
            // Permissions must be read from THIS exact native session and
            // PID/start identity. A correctly ordered ruleset from another
            // session or a restarted process is not an authorization.
            // A V2.0.21 session ASK rule alone is not effective ASK:
            // persisted project-scoped "always" grants can resolve it to ALLOW,
            // as the isolated native TEST demonstrates. The current owner
            // readback only attests session rules, not persisted grants or plugin
            // resolution. Hold an effective ASK until that native proof exists.
            // A stricter session DENY is tested to win before grants/hooks.
            const initialPolicy = effective && preflightOpenCodeV2EffectiveExternalDirectory(
              effective.rules, requiredExternalDirectory);
            if (!effective || initialPolicy?.kind !== 'policy-candidate' ||
                initialPolicy.effect === 'ask' ||
                effective.nativeSessionId !== profile.nativeSessionId ||
                effective.pid !== admittedCustody.pid ||
                effective.startIdentity !== admittedCustody.startIdentity ||
                combined.aborted || !current()) return false;
            // A native session being reachable is NOT a ready Team member.
            // Initial role/team/workspace instructions need native readback;
            // never infer their installation from probe or a local digest.
            initialContextAttempt ??= Promise.resolve().then(() => {
              if (combined.aborted || !current()) return undefined;
              return capturedInstallAndAttestInitialContext(Object.freeze({
                nativeSessionId: profile.nativeSessionId!,
                instructions: capturedInstructions,
                contextDigest,
                generation: capturedGeneration,
                configRevision: capturedConfigRevision,
              }), combined);
            });
            // A callback receipt is not an immutable native acknowledgement:
            // a getter could rewrite a foreign digest before the next field
            // comparison. Capture only own, enumerable JSON data fields.
            const attested = snapshotOpenCodeV2InitialContextReadback(
              await awaitOpenCodeV2OwnerReadback(() => initialContextAttempt!, combined));
            if (!attested || combined.aborted || !current() ||
                attested.nativeSessionId !== profile.nativeSessionId ||
                attested.contextDigest !== contextDigest ||
                attested.generation !== capturedGeneration ||
                attested.configRevision !== capturedConfigRevision) return false;
            // A process or policy may change during the initial native PUT.
            // Re-attest both after the mutation; never retry a lost PUT ACK.
            const finalEffective = snapshotOpenCodeV2PermissionReadback(
              await awaitOpenCodeV2OwnerReadback(() => capturedReadNativeEffectivePermissions(combined), combined));
            const finalPolicy = finalEffective && preflightOpenCodeV2EffectiveExternalDirectory(
              finalEffective.rules, requiredExternalDirectory);
            if (!finalEffective || finalPolicy?.kind !== 'policy-candidate' ||
                finalPolicy.effect === 'ask' ||
                finalEffective.nativeSessionId !== profile.nativeSessionId ||
                finalEffective.pid !== admittedCustody.pid ||
                finalEffective.startIdentity !== admittedCustody.startIdentity ||
                combined.aborted || !current()) return false;
            const finalCustodyReceipt = await awaitOpenCodeV2OwnerReadback(
              () => capturedReadNativeCustody(combined), combined);
            // Re-attest process custody after the native context PUT. A
            // getter-backed or Proxy identity is not a native witness.
            const finalCustody = snapshotOpenCodeV2CustodyReadback(finalCustodyReceipt);
            if (!finalCustody || combined.aborted || !current() ||
                finalCustody.executablePath !== admittedCustody.executablePath ||
                finalCustody.executableSha256 !== admittedCustody.executableSha256 ||
                finalCustody.version !== admittedCustody.version ||
                finalCustody.pid !== admittedCustody.pid ||
                finalCustody.startIdentity !== admittedCustody.startIdentity) return false;
            initialEvidence = {
              kind: 'native-configuration', contextDigest,
              generation: capturedGeneration,
              configRevision: capturedConfigRevision,
            };
            ready = true;
            capturedOnProgress();
            // Progress callbacks may synchronously revoke the selected Host
            // lease/generation. Never return a positive native readiness ACK
            // from the first probe after that revocation.
            if (combined.aborted || !current()) return false;
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
                if (!admissionSettled() || !authorized) {
                  // A concurrent native re-attestation makes ready transiently false.
                  // Fence this operation, but never stop a healthy owned PID unless
                  // its actual Host authority has been revoked.
                  if (!authorized && !await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const,
                  code: 'unavailable' as const, delivery: 'known-not-sent' as const };
                }
                const dispatchedEpoch = readinessEpoch;
                let reply: Awaited<ReturnType<typeof source.submit>>;
                try {
                  reply = await source.submit(input);
                } catch (error) {
                  const stopped = await finishOwned();
                  if (!stopped) throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
                  throw error;
                }
                // Native mutation may have been ACKed after Host seal or lease loss.
                // Never expose a successful handoff from a revoked generation,
                // and never claim known-not-sent or replay that uncertain POST.
                if (!current()) {
                  if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const, code: 'unknown' as const };
                }
                // An ACK during re-attestation can represent an effect that
                // was already committed while effective policy was unproven.
                // Quarantine this capture: UNKNOWN delivery must not silently
                // become eligible for a later dispatch if readiness recovers.
                if (reply.ok && (!admissionSettled() || readinessEpoch !== dispatchedEpoch)) {
                  if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const, code: 'unknown' as const };
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
              // The private EventFeed is permanently single-claim. Even a
              // consumer cancellation must retire this TEST-owned capture:
              // otherwise no future observer can receive terminal evidence.
              observe: () => {
                const stream = (async function* () {
                // The private EventFeed deliberately drains buffered events
                // after end(). That is safe for its own Session semantics, but
                // must NOT leak events across a revoked Host generation.
                const iterator = source.observe()[Symbol.asyncIterator]();
                let wakeRevocation!: () => void;
                const revoked = new Promise<void>((resolve) => { wakeRevocation = resolve; });
                const onAbort = () => wakeRevocation();
                abort.signal.addEventListener('abort', onAbort, { once: true });
                if (abort.signal.aborted) onAbort();
                // Host allocation/lease authority can be revoked without a
                // native event or an explicit seal() call. The private feed
                // offers no cancellation subscription, so monitor only while
                // an observer is active; an idle next() must not stay live.
                const leaseWatch = setInterval(() => {
                  try {
                    if (!current()) wakeRevocation();
                  } catch {
                    // A broken authority provider is not affirmative custody.
                    qualificationRevoked = true;
                    abort.abort();
                    void finishOwned();
                  }
                }, 250);
                leaseWatch.unref();
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
                    // await creates a microtask gap: Host authority or a new
                    // native re-attestation can change after the prior check.
                    // Keep this already-read event until the final synchronous
                    // guard is true; never replay the private feed's next().
                    for (;;) {
                      if (!await waitForAttestation() || !current()) {
                        authorityLost = true;
                        break;
                      }
                      if (ready && pendingReattestations.size === 0) break;
                    }
                    if (authorityLost) break;
                    yield outcome.value.value;
                    capturedOnProgress();
                  }
                } catch (error) {
                  if (!await finishOwned())
                    throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
                  throw error;
                } finally {
                  clearInterval(leaseWatch);
                  abort.signal.removeEventListener('abort', onAbort);
                  try {
                    // The pinned EventFeed does not accept cancellation. On
                    // revocation its pending next() must be woken by closing
                    // the captured private session, before returning its inner
                    // iterator. close() uses the existing single-flight owner
                    // stop/confirmation and never replays a native mutation.
                    if (authorityLost) {
                      // Even a rejected native close must not skip the inner
                      // EventFeed iterator's finally/finalization path.
                      await finalizeOpenCodeV2ObserverAfterClose(
                        () => source.close(), () => iterator.return?.());
                    } else {
                      await iterator.return?.();
                    }
                  } finally {
                    if ((authorityLost || exhausted) && !await finishOwned())
                      throw new Error('opencode.v2.owner-cleanup-unknown');
                  }
                }
                })();
                return guardOpenCodeV2ObserverCleanup(stream, () => source.close(), finishOwned);
              },
              respondToInteraction: async (reference, reply) => {
                // V2 permission replies are native mutations. Never let a
                // retained driver handle grant after Host seal/lease loss.
                const authorized = current();
                if (!admissionSettled() || !authorized) {
                  // A concurrent native re-attestation makes ready transiently false.
                  // Fence this operation, but never stop a healthy owned PID unless
                  // its actual Host authority has been revoked.
                  if (!authorized && !await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const, code: 'unavailable' as const };
                }
                const dispatchedEpoch = readinessEpoch;
                try {
                  const result = await source.respondToInteraction(reference, reply);
                  // A late permission ACK cannot grant after Host authority loss.
                  if (!current()) {
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                    return { ok: false as const, code: 'unknown' as const };
                  }
                  // A potentially applied permission during unproven
                  // re-attestation cannot be reopened for later dispatch.
                  if (result.ok && (!admissionSettled() || readinessEpoch !== dispatchedEpoch)) {
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                    return { ok: false as const, code: 'unknown' as const };
                  }
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
                if (!admissionSettled() || !authorized) {
                  // A concurrent native re-attestation makes ready transiently false.
                  // Fence this operation, but never stop a healthy owned PID unless
                  // its actual Host authority has been revoked.
                  if (!authorized && !await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const, code: 'unavailable' as const };
                }
                const dispatchedEpoch = readinessEpoch;
                try {
                  const result = await source.interrupt(operation);
                  // Interrupt may already have reached the native engine.
                  // A post-seal response is UNKNOWN, not safe to resend.
                  if (!current()) {
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                    return { ok: false as const, code: 'unknown' as const };
                  }
                  // An interrupt ACK during re-attestation can be applied
                  // without a current policy proof: quarantine this capture.
                  if (result.ok && (!admissionSettled() || readinessEpoch !== dispatchedEpoch)) {
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                    return { ok: false as const, code: 'unknown' as const };
                  }
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
                if (!admissionSettled() || !authorized) {
                  // A concurrent native re-attestation makes ready transiently false.
                  // Fence this operation, but never stop a healthy owned PID unless
                  // its actual Host authority has been revoked.
                  if (!authorized && !await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  return { ok: false as const, code: 'unavailable' as const };
                }
                // Private D probes internally for each queued submit; that is the
                // mutation's own admission, not a competing Host re-attestation.
                // Only an explicit Host check invalidates an in-flight ACK epoch.
                readinessEpoch++;
                try {
                  const result = await source.checkReadiness();
                  // A native readiness ACK is not a renewed Host lease: the
                  // generation can be revoked while the private check awaits.
                  // Recheck Host authority before exposing any successful ACK.
                  if (!current()) {
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                    return { ok: false as const, code: 'unavailable' as const };
                  }
                  // A concurrent native re-attestation may have fenced this
                  // handle without revoking its captured process.
                  if (!admissionSettled()) return { ok: false as const, code: 'unavailable' as const };
                  if (!result.ok) {
                    if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown');
                  }
                  return result;
                } catch (error) {
                  if (!await finishOwned()) throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
                  throw error;
                }
              },
              checkpoint: () => admissionSettled() && current() ? source.checkpoint() :
                { ok: false as const, code: 'unavailable' as const },
              close: async () => {
                // Retire the captured TEST-owned native process immediately.
                // The private SPI bounds shutdown and can return UNKNOWN
                // before its own confirmStopped callback is reached.
                const stopped = finishOwned();
                let privateCleanupConfirmed = false;
                try {
                  privateCleanupConfirmed = (await source.close()).cleanup === 'confirmed';
                } catch {
                  // The independent physical stop/readback still decides custody.
                }
                const physicallyStopped = await stopped;
                return {
                  logicallyClosed: true as const,
                  cleanup: physicallyStopped && privateCleanupConfirmed ?
                    'confirmed' as const : 'unknown' as const,
                };
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
    isReady: () => admissionSettled() && current(),
    initialContextEvidence: () => admissionSettled() && current() ? initialEvidence : undefined,
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
