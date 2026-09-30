import { decodeNativeLaunchAdmission, type NativeLaunchRequest } from './selected-native-admission-contract';
import type { SupervisorPlan } from '../processes';
import { decodeApprovalGenerationTransition, approvalGenerationTransitionSigningBytes,
  type ApprovalGenerationTransition } from '../../../../src/main/composition/hosted/hostedApprovalGenerationTransitionContract';
import { decodeNativeSuccessorHandle } from '../../../../src/main/composition/hosted/hostedNativeSuccessorHandleContract';
import type { NativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';
import type { NativeActivationSocketIdentity } from '../../../../src/main/composition/hosted/hostedNativeActivationSocketIdentity';
import { assertSelectedPlanAdmission, type SelectedPlanAdmission } from './selected-plan-admission';
import { SelectedControllerChannel, SELECTED_CONTROLLER_CHANNEL } from './selected-controller-channel';
import { decodeSelectedPrivateInputs } from './selected-private-inputs';
import { canonicalJson, exactRecord, sha256 } from './canonical';

/** Namespace side of FD3. Signatures remain subject to the actual Product
 * generation/handle verifiers; channel ownership is never authority or ready. */
export class SelectedControllerClient {
  #sequence = 0;
  #pending?: ApprovalGenerationTransition;
  #requesting = false;
  #privateRead = false;
  #privateReady = false;
  #closed = false;
  constructor(readonly channel: SelectedControllerChannel, readonly plan: SupervisorPlan,
    readonly admission: SelectedPlanAdmission, readonly signal: AbortSignal) {}
  async privateInputs() {
    if (this.#privateRead) { this.#closed = true; this.channel.close(); throw new Error('selected_private_input_reused'); }
    this.#privateRead = true;
    try {
      assertSelectedPlanAdmission(this.admission, this.plan);
      await this.channel.write({ contract: SELECTED_CONTROLLER_CHANNEL, kind: 'private-inputs',
        controllerNonce: this.plan.controllerNonce, runId: this.plan.runId, planSha256: sha256(canonicalJson(this.plan)),
        process: { pid: this.admission.process.pid, startTicks: this.admission.process.startTicks } });
      const row = exactRecord(await this.channel.read(this.signal), ['contract', 'kind', 'inputs'], 'selected_private_response');
      if (row.contract !== SELECTED_CONTROLLER_CHANNEL || row.kind !== 'private-inputs') throw new Error('selected_private_response');
      const inputs = decodeSelectedPrivateInputs(row.inputs, this.plan);
      this.#privateReady = true; return inputs;
    } catch { this.#closed = true; this.channel.close(); throw new Error('selected_private_inputs_failed'); }
  }
  async #issue(request: unknown, signal = this.signal): Promise<unknown> {
    if (this.#closed || !this.#privateReady || this.#requesting || this.#sequence >= 10) {
      this.#closed = true; this.channel.close(); throw new Error('selected_issuance_order');
    }
    const kinds = ['native', 'transition', 'native', 'successor-handle', 'transition',
      'native', 'successor-handle', 'transition', 'native', 'successor-handle'];
    if (!request || typeof request !== 'object' || Reflect.get(request, 'kind') !== kinds[this.#sequence]) {
      this.#closed = true; this.channel.close(); throw new Error('selected_issuance_order');
    }
    this.#requesting = true;
    try {
      assertSelectedPlanAdmission(this.admission, this.plan);
      const sequence = ++this.#sequence;
      await this.channel.write({ contract: SELECTED_CONTROLLER_CHANNEL, kind: 'issue', sequence,
        controllerNonce: this.plan.controllerNonce, runId: this.plan.runId, request });
      const row = exactRecord(await this.channel.read(signal), ['contract', 'kind', 'sequence', 'response'], 'selected_issuance_response');
      if (row.contract !== SELECTED_CONTROLLER_CHANNEL || row.kind !== 'issued' || row.sequence !== sequence) {
        throw new Error('selected_issuance_response');
      }
      assertSelectedPlanAdmission(this.admission, this.plan);
      return row.response;
    } catch { this.#closed = true; this.channel.close(); throw new Error('selected_issuance_failed'); }
    finally { this.#requesting = false; }
  }
  async nativeAdmission(request: NativeLaunchRequest, signal: AbortSignal) {
    try {
      const admission = decodeNativeLaunchAdmission(await this.#issue(request, AbortSignal.any([this.signal, signal])));
      const s = admission.statement;
      if (s.generation.generation !== request.generation || s.ownerProcessStartToken !== request.ownerProcessStartToken ||
        s.launchSha256 !== sha256(canonicalJson(request.launch)) || s.sealedSha256 !== sha256(canonicalJson(request.sealed))) {
        throw new Error('selected_native_substitution');
      }
      // Structural binding only. Owner independently verifies its installed root.
      return admission;
    } catch { this.#closed = true; this.channel.close(); throw new Error('selected_native_failed'); }
  }
  async transition(generation: number, predecessorProcessStartToken: string, predecessorManifestDigest: string,
    bootstrapDigest: string) {
    try {
      if (this.#pending) { this.#closed = true; this.channel.close(); throw new Error('selected_transition_pending'); }
      const ticket = decodeApprovalGenerationTransition(await this.#issue({ kind: 'transition', generation,
        predecessorProcessStartToken, predecessorManifestDigest }));
      if (ticket.successorGeneration !== generation || ticket.predecessorProcessStartToken !== predecessorProcessStartToken ||
        ticket.predecessorManifestDigest !== predecessorManifestDigest || ticket.successorBootstrapDigest !== bootstrapDigest) {
        this.channel.close(); throw new Error('selected_transition_substitution');
      }
      this.#pending = ticket;
      return ticket;
    } catch { this.#closed = true; this.channel.close(); throw new Error('selected_transition_failed'); }
  }
  async successorHandle(selection: NativeActivationHandleSelection, endpointIdentity: NativeActivationSocketIdentity) {
    try {
      const pending = this.#pending;
      if (!pending || pending.successorGeneration !== selection.ownerGeneration ||
        pending.successorSessionId !== selection.ownerSessionId || pending.successorBootstrapDigest !== selection.bootstrapDigest) {
        this.#closed = true; this.channel.close(); throw new Error('selected_handle_transition');
      }
      const transitionSha256 = sha256(approvalGenerationTransitionSigningBytes(pending));
      const handle = decodeNativeSuccessorHandle(await this.#issue({ kind: 'successor-handle',
        selection, endpointIdentity, transitionSha256 }));
      if (handle.transitionSha256 !== transitionSha256 || canonicalJson(handle.selection) !== canonicalJson(selection) ||
        canonicalJson(handle.endpointIdentity) !== canonicalJson(endpointIdentity)) {
        this.channel.close(); throw new Error('selected_handle_substitution');
      }
      this.#pending = undefined;
      return handle;
    } catch { this.#closed = true; this.channel.close(); throw new Error('selected_handle_failed'); }
  }
}
