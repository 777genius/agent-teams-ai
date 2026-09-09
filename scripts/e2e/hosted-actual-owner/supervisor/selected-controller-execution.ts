import { assertProductActivationSigningBinding } from './selected-product-signing-reference';
/** Controller-only composition. This is imported by executeSupervisor, never
 * by the selected namespace entry or its preparation closure. */
import type { Duplex } from 'node:stream';
import { parseIntegrationDescriptor } from '../contracts';
import type { SupervisorPlan } from '../processes';
import { SelectedControllerChannel, SELECTED_CONTROLLER_CHANNEL } from './selected-controller-channel';
import { decodeSelectedPrivateInputs, type SelectedPrivateInputs } from './selected-private-inputs';
import { SelectedRootIssuer, type SelectedRootIssuanceInputs } from './selected-root-issuer';
import { canonicalJson, exactRecord, sha256 } from './canonical';
import { observeSelectedControllerProcess } from './selected-controller-process';

export interface SelectedControllerExecutionInputs {
  readonly namespace: SelectedPrivateInputs;
  readonly issuance: SelectedRootIssuanceInputs;
}
/** Own the concrete existing signing operation in the root's run scope. The
 * exported value has no method for extracting a key or replacing a signer. */
export function prepareSelectedControllerExecution(plan: SupervisorPlan, input: SelectedControllerExecutionInputs) {
  const namespace = decodeSelectedPrivateInputs(input.namespace, plan);
  if (!plan.ownerPreparationModule || !plan.supervisorSourceInvocation ||
    input.issuance.expectedOpenCodeExecutableSha256 !== plan.expectedExecutableSha256.opencode ||
    input.issuance.serializedProductBootstrap !== namespace.serializedProductBootstrap ||
    input.issuance.predecessor.artifactDigest !== `sha256:${namespace.launcherArtifactDigest}` ||
    input.issuance.predecessor.bootstrapBinding.proofKeyId !== sha256(Buffer.from(namespace.bootstrapProofKeyBase64, 'base64'))) {
    throw new Error('selected_controller_execution_binding');
  }
  const descriptor = parseIntegrationDescriptor(Buffer.from(input.issuance.native.controllerDescriptor));
  if (canonicalJson(descriptor) !== canonicalJson(plan.supervisorAdmissionDescriptor) ||
    input.issuance.native.allocation.generations.some((g, index) => {
      const common = namespace.generations[index].common;
      return g.ownerSessionId !== common.ownerSessionId || g.slots[0].teamId !== common.teamId ||
        `sha256:${g.admissionDocumentSha256}` !== common.approvalActivationV2.admissionDocumentDigest;
    })) throw new Error('selected_native_root_selection');
  assertProductActivationSigningBinding(namespace.productActivationSigning, input.issuance.native.activation);
  const issuer = new SelectedRootIssuer(input.issuance);
  let channel: SelectedControllerChannel | undefined;
  let started = false;
  let complete = false;
  let processReceipt: Awaited<ReturnType<typeof observeSelectedControllerProcess>> | undefined;
  return Object.freeze({
    /** Called only with stdio[3] of executeSupervisor's just-anchored child. */
    async serve(stream: Duplex, launcherHostPid: number, signal: AbortSignal): Promise<void> {
      if (started) throw new Error('selected_controller_reused');
      started = true;
      channel = new SelectedControllerChannel(stream);
      try {
        await channel.write({ contract: SELECTED_CONTROLLER_CHANNEL, kind: 'plan', plan });
        const request = exactRecord(await channel.read(signal, 30_000, true),
          ['contract', 'kind', 'controllerNonce', 'runId', 'planSha256', 'process'], 'selected_private_request');
        if (request.contract !== SELECTED_CONTROLLER_CHANNEL || request.kind !== 'private-inputs' ||
          request.controllerNonce !== plan.controllerNonce || request.runId !== plan.runId ||
          request.planSha256 !== sha256(canonicalJson(plan))) throw new Error('selected_controller_private_request');
        processReceipt = await observeSelectedControllerProcess(launcherHostPid, plan, request.process, signal);
        await channel.write({ contract: SELECTED_CONTROLLER_CHANNEL, kind: 'private-inputs', inputs: namespace }, true);
        for (let sequence = 1; sequence <= 10; sequence++) {
          const envelope = exactRecord(await channel.read(signal, plan.maximumRuntimeMs, true),
            ['contract', 'kind', 'sequence', 'controllerNonce', 'runId', 'request'], 'selected_issuance_request');
          if (envelope.contract !== SELECTED_CONTROLLER_CHANNEL || envelope.kind !== 'issue' ||
            envelope.sequence !== sequence || envelope.controllerNonce !== plan.controllerNonce || envelope.runId !== plan.runId) {
            throw new Error('selected_controller_issuance_request');
          }
          // Initial channel admission does not survive loss/replacement of its
          // selected namespace process. Reobserve the exact host ancestry,
          // namespace PID/start, argv and executing image before every use of
          // root signing custody; never accept a new identity from the request.
          const reserved = issuer.reserve(envelope.request);
          const native = Reflect.get(envelope.request as object, 'kind') === 'native';
          const exchangeSignal = AbortSignal.any([signal, channel.closedSignal,
            ...(native ? [AbortSignal.timeout(5000)] : [])]);
          const currentProcess = await observeSelectedControllerProcess(launcherHostPid, plan,
            { pid: processReceipt.pid, startTicks: processReceipt.startTime }, exchangeSignal);
          if (canonicalJson(currentProcess) !== canonicalJson(processReceipt)) {
            throw new Error('selected_controller_process_changed');
          }
          const response = await reserved.finish(exchangeSignal);
          await channel.write({ contract: SELECTED_CONTROLLER_CHANNEL, kind: 'issued', sequence, response }, true);
        }
        complete = true;
        // No ready/success authority is inferred from issuance. The existing
        // process/transcript/evidence path decides completion independently.
      } catch {
        channel.close();
        throw new Error('selected_controller_execution_failed');
      } finally { issuer.close(); }
    },
    assertComplete() { if (!complete) throw new Error('selected_controller_issuance_incomplete'); },
    processReceipt() { if (!processReceipt) throw new Error('selected_controller_process_missing'); return processReceipt; },
    close() { issuer.close(); channel?.close(); },
  });
}
