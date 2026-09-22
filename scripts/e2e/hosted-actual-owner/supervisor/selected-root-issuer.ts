/** Controller-side only. Never include this module (or its KeyObject) in the
 * namespace closure. Uses the existing launcher custody and signing bytes. */
import { createPublicKey, sign, type KeyObject } from 'node:crypto';
import { APPROVAL_GENERATION_TRANSITION, approvalGenerationTransitionSigningBytes,
  decodeApprovalGenerationTransition, type ApprovalGenerationTransition,
} from '../../../../src/main/composition/hosted/hostedApprovalGenerationTransitionContract';
import { NATIVE_SUCCESSOR_HANDLE, nativeSuccessorHandleSigningBytes,
  decodeNativeSuccessorHandle, type NativeSuccessorHandle,
} from '../../../../src/main/composition/hosted/hostedNativeSuccessorHandleContract';
import { decodeNativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';
import { authenticateHostedLifecycleAdmissionManifest } from '../../../../src/main/composition/hosted/hostedLifecycleOwnerAdmissionManifest';
import { assertBootstrapBinding, parseAdmissionPayload } from '../../../../src/main/composition/hosted/hostedLifecycleProductionOwnerAdmission';
import type { HostedLifecycleProductionOwnerAdmission } from '../../../../src/main/composition/hosted/hostedLifecycleProductionOwnerAdmission';
import { canonicalJson, exactRecord, sha256 } from './canonical';

import { decodeNativeAllocation, immutableAllocation, type NativeAllocationSelection, type NativeGenerationSelection } from './selected-operation-allocation';
import { NATIVE_LAUNCH_ADMISSION, decodeNativeLaunchAdmission, decodeNativeLaunchRequest,
  decodeNativeAdmissionStatement, decodeNativeAdmissionSelection, nativeLaunchAdmissionSigningBytes, type NativeAdmissionStatement,
  type SelectedNativeObservationAuthority, type SelectedSuccessorEndpointObservationAuthority } from './selected-native-admission-contract';
import type { ControllerTrustAnchor } from '../controller-authority';

export interface SelectedRootIssuanceInputs {
  readonly native: Readonly<{
    allocation: NativeAllocationSelection;
    controllerDescriptor: string;
    controllerTrustAnchor: ControllerTrustAnchor;
    activation: NativeAdmissionStatement['activation'];
    observations: SelectedNativeObservationAuthority;
    endpointObservations: SelectedSuccessorEndpointObservationAuthority;
  }>;
  readonly expectedOpenCodeExecutableSha256: string;
  readonly launcherKey: KeyObject;
  readonly predecessor: HostedLifecycleProductionOwnerAdmission;
  readonly serializedProductBootstrap: string;
  readonly initialAdmissionDocument: string;
  /** Root's exact signed v4 documents; no namespace-supplied replacement payload. */
  readonly successors: readonly {
    generation: number; admissionDocument: string; successorManifest: string;
  }[];
}
function check(value: unknown): asserts value { if (!value) throw new Error('selected_root_issuance_rejected'); }

/** Root data authentication only. Product runtime adoption remains the separate
 * slice-3 verifier. Unlike its singleton projection this checks the exact signed
 * slot vector, without granting activation or endpoint possession. */
function admitRootSuccessor(serialized: string, predecessor: HostedLifecycleProductionOwnerAdmission,
  bootstrap: string, generation: NativeGenerationSelection): HostedLifecycleProductionOwnerAdmission {
  check(Buffer.byteLength(serialized) <= 16_384);
  const authenticated = authenticateHostedLifecycleAdmissionManifest(serialized, predecessor);
  check(authenticated.version === 4);
  const parsed = parseAdmissionPayload(authenticated.payload, '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock', 4);
  assertBootstrapBinding(parsed.bootstrapBinding, bootstrap, predecessor.artifactDigest, predecessor.bootstrapBinding.proofKeyId);
  check(parsed.artifact.artifactDigest === predecessor.artifactDigest && parsed.artifact.imageReference === predecessor.imageReference &&
    parsed.artifact.artifactVersion === predecessor.artifactVersion && parsed.artifact.protocolVersion === predecessor.protocolVersion &&
    parsed.expectedOwnerBinding.ownerAuthority === predecessor.ownerAuthority &&
    parsed.expectedOwnerBinding.ownerGeneration === predecessor.expectedOwnerBinding.ownerGeneration + 1 &&
    parsed.expectedOwnerBinding.ownerSessionId !== predecessor.expectedOwnerBinding.ownerSessionId &&
    parsed.expectedOwnerBinding.ownerSessionId === generation.ownerSessionId &&
    canonicalJson(parsed.bootstrapBinding) === canonicalJson(predecessor.bootstrapBinding) && parsed.approvalAdmission.state === 'active' &&
    parsed.approvalRoutes.length === generation.slots.length && generation.slots.every(slot =>
      parsed.approvalRoutes.filter(route => route.teamId === slot.teamId && route.socketPath === slot.lifecycleEndpoint &&
        route.ownerGeneration === generation.generation && route.ownerSessionId === generation.ownerSessionId).length === 1));
  return Object.freeze({ ...predecessor, ...parsed.artifact, expectedOwnerBinding: parsed.expectedOwnerBinding,
    bootstrapBinding: parsed.bootstrapBinding, approvalAdmission: parsed.approvalAdmission,
    approvalSnapshot: parsed.approvalSnapshot, approvalRoutes: parsed.approvalRoutes, manifestDigest: `sha256:${sha256(serialized)}` as const });
}

/** Four native admissions, three transitions and three observed-handle signatures in the existing
 * controller lifetime. Requests cannot select a signing key, rotate bootstrap,
 * provide admission documents, skip a generation, or reuse an actual start. */
export class SelectedRootIssuer {
  readonly #key: KeyObject;
  readonly #bootstrap: string;
  readonly #openCode: string;
  readonly #successors: SelectedRootIssuanceInputs['successors'];
  #predecessor: HostedLifecycleProductionOwnerAdmission;
  #pending?: { ticket: ApprovalGenerationTransition; manifest: string;
    successor: HostedLifecycleProductionOwnerAdmission };
  #starts = new Set<string>();
  #previousStart?: string;
  #closed = false;
  #sequence = 0;
  #reserved = false;
  #nativeStarts = new Map<number, string>();
  readonly #native: Omit<SelectedRootIssuanceInputs['native'], 'observations' | 'endpointObservations'>;
  readonly #endpointObserve: SelectedSuccessorEndpointObservationAuthority['observe'];
  readonly #nativeLaunches = new Map<number, Readonly<{ launchSha256: string; sealedSha256: string;
    ownerProcessStartToken: string; bootstrapV2HeaderSha256: string }>>();
  readonly #observe: SelectedNativeObservationAuthority['observe'];
  constructor(input: SelectedRootIssuanceInputs) {
    check(input.launcherKey.type === 'private' && input.launcherKey.asymmetricKeyType === 'ed25519');
    check(createPublicKey(input.launcherKey).export({ format: 'jwk' }).x === input.predecessor.launcherPublicKey);
    check(input.predecessor.expectedOwnerBinding.ownerGeneration === 1 &&
      sha256(input.serializedProductBootstrap) === input.predecessor.bootstrapBinding.bootstrapDigest);
    check(input.successors.length === 3 && input.successors.every((row, index) => row.generation === index + 2));
    this.#native = decodeNativeAdmissionSelection({ allocation: decodeNativeAllocation(input.native.allocation),
      controllerDescriptor: input.native.controllerDescriptor, controllerTrustAnchor: input.native.controllerTrustAnchor,
      activation: input.native.activation });
    check(typeof input.native.observations?.observe === 'function');
    check(typeof input.native.endpointObservations?.observe === 'function');
    this.#endpointObserve = input.native.endpointObservations.observe.bind(input.native.endpointObservations);
    this.#observe = input.native.observations.observe.bind(input.native.observations);
    check(createPublicKey(input.launcherKey).export({ format: 'der', type: 'spki' }).toString('base64url') !==
      this.#native.activation.publicKeySpkiDerBase64url);
    check(this.#native.allocation.generations[0].ownerSessionId === input.predecessor.expectedOwnerBinding.ownerSessionId &&
      `sha256:${this.#native.allocation.generations[0].manifestSha256}` === input.predecessor.manifestDigest);
    const documents = [input.initialAdmissionDocument, ...input.successors.map(row => row.admissionDocument)];
    for (const [index, document] of documents.entries()) {
      check(typeof document === 'string' && Buffer.byteLength(document) > 0 && Buffer.byteLength(document) <= 256 * 1024);
      const generation = this.#native.allocation.generations[index];
      check(sha256(document) === generation.admissionDocumentSha256);
      const parsed = JSON.parse(document) as { routes?: readonly { routeId?: string; scope?: { teamId?: string } }[] };
      check(Array.isArray(parsed.routes) && parsed.routes.length === generation.slots.length && generation.slots.every(slot =>
        parsed.routes!.filter(route => route.routeId === slot.routeId && route.scope?.teamId === slot.teamId &&
          sha256(canonicalJson(route)) === slot.routeDigest).length === 1));
    }
    this.#key = input.launcherKey;
    check(/^[0-9a-f]{64}$/u.test(input.expectedOpenCodeExecutableSha256));
    this.#openCode = input.expectedOpenCodeExecutableSha256;
    this.#bootstrap = input.serializedProductBootstrap;
    this.#predecessor = structuredClone(input.predecessor);
    this.#successors = structuredClone(input.successors);
    let previous = this.#predecessor;
    for (const row of this.#successors) {
      previous = admitRootSuccessor(row.successorManifest, previous, this.#bootstrap, this.#native.allocation.generations[row.generation - 1]);
      const native = this.#native.allocation.generations[row.generation - 1];
      check(native.ownerSessionId === previous.expectedOwnerBinding.ownerSessionId &&
        native.admissionDocumentSha256 === sha256(row.admissionDocument) && native.manifestSha256 === sha256(row.successorManifest));
      check(Buffer.byteLength(row.admissionDocument) <= 256 * 1024 && row.admissionDocument.length > 0);
    }
  }
  /** Reserve before *any* controller/native observation await. An overlapping
   * reservation permanently poisons both the new and already pending exchange. */
  reserve(request: unknown) {
    try {
      check(!this.#closed && !this.#reserved && this.#sequence < 10);
      this.#reserved = true;
      const selected = immutableAllocation(structuredClone(request));
      const kinds = ['native', 'transition', 'native', 'successor-handle', 'transition',
        'native', 'successor-handle', 'transition', 'native', 'successor-handle'];
      check(selected && typeof selected === 'object' && Reflect.get(selected, 'kind') === kinds[this.#sequence]);
      const sequence = this.#sequence++;
      let used = false;
      return Object.freeze({ finish: async (signal: AbortSignal) => {
        try {
          check(!used && !this.#closed); used = true; signal.throwIfAborted();
          let result;
          if (Reflect.get(selected, 'kind') === 'native') {
            const r = decodeNativeLaunchRequest(selected);
            const generation = [1, 0, 2, 0, 0, 3, 0, 0, 4][sequence];
            check(r.generation === generation && !this.#nativeStarts.has(generation) &&
              ![...this.#nativeStarts.values()].includes(r.ownerProcessStartToken));
            const host = r.launch.expectedHost as { activation?: Record<string, unknown>; executable?: { sha256?: string } };
            const expected = this.#native.allocation.generations[generation - 1];
            check(host?.activation?.ownerGeneration === generation && host.activation.ownerSessionId === expected.ownerSessionId &&
              host.activation.admissionDocumentDigest === `sha256:${expected.admissionDocumentSha256}` &&
              host.activation.bootstrapDigest === sha256(this.#bootstrap) && host.executable?.sha256 === this.#openCode);
            const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
            const observed = await new Promise<Awaited<ReturnType<SelectedNativeObservationAuthority['observe']>>>((resolve, reject) => {
              const abort = () => { cleanup(); reject(new Error('selected_native_observation_cancelled')); };
              const cleanup = () => bounded.removeEventListener('abort', abort);
              bounded.addEventListener('abort', abort, { once: true });
              if (bounded.aborted) { abort(); return; }
              try {
                this.#observe(r, bounded).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
              } catch (error) { cleanup(); reject(error); }
            });
            bounded.throwIfAborted();
            signal.throwIfAborted(); check(!this.#closed);
            check(observed.launchSha256 === sha256(canonicalJson(r.launch)) &&
              observed.sealedSha256 === sha256(canonicalJson(r.sealed)) && observed.ownerProcessStartToken === r.ownerProcessStartToken &&
              /^[0-9a-f]{64}$/u.test(observed.bootstrapV2HeaderSha256) &&
              observed.bootstrapV2HeaderSha256 === r.launch.bootstrapV2HeaderSha256);
            if (generation === 4) check(observed.predecessorResults.every(p => p.ownerProcessStartToken === this.#nativeStarts.get(3)));
            const statement = decodeNativeAdmissionStatement({ format: NATIVE_LAUNCH_ADMISSION,
              launchSha256: observed.launchSha256, sealedSha256: observed.sealedSha256,
              ownerProcessStartToken: observed.ownerProcessStartToken,
              ...this.#native, allocationSha256: sha256(canonicalJson(this.#native.allocation)),
              generation: this.#native.allocation.generations[generation - 1], predecessorResults: observed.predecessorResults });
            result = decodeNativeLaunchAdmission({ statement,
              signatureBase64url: sign(null, nativeLaunchAdmissionSigningBytes(statement), this.#key).toString('base64url') });
            this.#nativeLaunches.set(generation, Object.freeze({ launchSha256: observed.launchSha256,
              sealedSha256: observed.sealedSha256, ownerProcessStartToken: observed.ownerProcessStartToken,
              bootstrapV2HeaderSha256: observed.bootstrapV2HeaderSha256 }));
            this.#nativeStarts.set(generation, r.ownerProcessStartToken);
          } else result = await this.#issueLegacy(selected, signal);
          check(!this.#closed); this.#reserved = false; return result;
        } catch { this.close(); throw new Error('selected_root_issuance_rejected'); }
      } });
    } catch { this.close(); throw new Error('selected_root_issuance_rejected'); }
  }
  issue(request: unknown, signal = new AbortController().signal) { return this.reserve(request).finish(signal); }
  async #issueLegacy(request: unknown, signal: AbortSignal): Promise<ApprovalGenerationTransition | NativeSuccessorHandle> {
    check(!this.#closed);
    try {
      check(request && typeof request === 'object');
      const kind = Reflect.get(request, 'kind');
      if (kind === 'transition') {
        const row = exactRecord(request, ['kind', 'generation', 'predecessorProcessStartToken', 'predecessorManifestDigest'], 'root_transition_request');
        check(!this.#pending && row.generation === this.#predecessor.expectedOwnerBinding.ownerGeneration + 1 &&
          row.predecessorManifestDigest === this.#predecessor.manifestDigest &&
          typeof row.predecessorProcessStartToken === 'string' && /^[0-9a-f]{64}$/u.test(row.predecessorProcessStartToken));
        const start = row.predecessorProcessStartToken;
        check(start === this.#nativeStarts.get(Number(row.generation) - 1));
        check(this.#previousStart ? start === this.#previousStart : !this.#starts.has(start));
        this.#starts.add(start);
        const selected = this.#successors.find(item => item.generation === row.generation);
        check(selected);
        const successor = admitRootSuccessor(selected.successorManifest, this.#predecessor, this.#bootstrap, this.#native.allocation.generations[selected.generation - 1]);
        const unsigned: ApprovalGenerationTransition = { contract: APPROVAL_GENERATION_TRANSITION,
          predecessorManifestDigest: this.#predecessor.manifestDigest, predecessorProcessStartToken: start,
          successorGeneration: selected.generation, successorSessionId: successor.expectedOwnerBinding.ownerSessionId,
          successorBootstrapDigest: this.#predecessor.bootstrapBinding.bootstrapDigest,
          admissionDocument: selected.admissionDocument, signature: '' };
        const ticket = decodeApprovalGenerationTransition({ ...unsigned,
          signature: sign(null, approvalGenerationTransitionSigningBytes(unsigned), this.#key).toString('base64url') });
        this.#pending = { ticket, manifest: selected.successorManifest, successor };
        return ticket;
      }
      check(kind === 'successor-handle');
      const row = exactRecord(request, ['kind', 'selection', 'endpointIdentity', 'transitionSha256'], 'root_handle_request');
      const pending = this.#pending; check(pending);
      const selection = decodeNativeActivationHandleSelection(row.selection);
      check(selection.ownerGeneration === pending.ticket.successorGeneration &&
        selection.ownerSessionId === pending.ticket.successorSessionId &&
        selection.bootstrapDigest === pending.ticket.successorBootstrapDigest &&
        selection.expectedOpenCodeExecutableSha256 === this.#openCode &&
        !this.#starts.has(selection.ownerProcessStartToken) &&
        selection.ownerProcessStartToken === this.#nativeStarts.get(selection.ownerGeneration));
      const native = this.#nativeLaunches.get(selection.ownerGeneration);
      check(native && selection.bootstrapV2HeaderSha256 === native.bootstrapV2HeaderSha256);
      const digest = sha256(approvalGenerationTransitionSigningBytes(pending.ticket));
      check(row.transitionSha256 === digest);
      const endpoint = exactRecord(row.endpointIdentity, ['device', 'inode'], 'root_endpoint');
      check(typeof endpoint.device === 'string' && /^[0-9]{1,32}$/u.test(endpoint.device) &&
        typeof endpoint.inode === 'string' && /^[1-9][0-9]{0,31}$/u.test(endpoint.inode));
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const observed = await new Promise<Readonly<{ device: string; inode: string }>>((resolve, reject) => {
        const abort = () => { cleanup(); reject(new Error('selected_endpoint_observation_cancelled')); };
        const cleanup = () => bounded.removeEventListener('abort', abort);
        bounded.addEventListener('abort', abort, { once: true });
        if (bounded.aborted) { abort(); return; }
        try {
          this.#endpointObserve(this.#native.allocation.generations[selection.ownerGeneration - 1], native, bounded)
            .then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        } catch (error) { cleanup(); reject(error); }
      });
      bounded.throwIfAborted(); signal.throwIfAborted(); check(!this.#closed);
      check(observed.device === endpoint.device && observed.inode === endpoint.inode);
      const unsigned: NativeSuccessorHandle = { contract: NATIVE_SUCCESSOR_HANDLE,
        transitionSha256: digest, selection, endpointIdentity: { device: endpoint.device, inode: endpoint.inode },
        successorManifest: pending.manifest, signature: '' };
      const result = decodeNativeSuccessorHandle({ ...unsigned,
        signature: sign(null, nativeSuccessorHandleSigningBytes(unsigned), this.#key).toString('base64url') });
      // Commit exactly once, only after both bounded message decoders passed.
      this.#starts.add(selection.ownerProcessStartToken); this.#previousStart = selection.ownerProcessStartToken;
      this.#predecessor = pending.successor; this.#pending = undefined;
      return result;
    } catch {
      this.#closed = true;
      // Root exceptions must never serialize signer objects or document values.
      throw new Error('selected_root_issuance_rejected');
    }
  }
  close(): void { this.#closed = true; this.#pending = undefined; }
}
