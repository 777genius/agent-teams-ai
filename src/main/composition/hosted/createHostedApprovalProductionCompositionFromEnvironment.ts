import {
  clearProductHostedProducerProvenance,
  installProductHostedProducerProvenance,
} from '@features/hosted-producer-provenance/main';

import {
  closeHostedApprovalRuntimeConnectedTransport,
  readHostedApprovalRuntimeActivationPublicationContract,
} from '../../services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';

import {
  createOptionalHostedApprovalProductionComposition,
  type CreateOptionalHostedApprovalProductionCompositionDependencies,
} from './createHostedApprovalProductionComposition';
import { HostedApprovalGenerationRuntime, type HostedApprovalGenerationRuntimeOptions } from './hostedApprovalGenerationRuntime';
import { installHostedNativeActivationReplacementReceiver, takeHostedNativeActivationHandle } from './hostedNativeActivationHandle';
import { createHostedProducerProvenanceFromEnvironment } from './hostedProducerProvenanceComposition';
import { createProductHostedProducerSseWriteEmitter } from './hostedProducerProvenanceNodeOperations';

import type { HostedOperatorProductionComposition } from './hostedOperatorProductionComposition';

/** Loads the pinned activation publication before applying the optional hosted composition gates. */
export async function createHostedApprovalProductionCompositionFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: Omit<
    CreateOptionalHostedApprovalProductionCompositionDependencies,
    'activationPublication'
  >,
  generationRuntime?: Pick<HostedApprovalGenerationRuntimeOptions, 'drainStreams' | 'revokeLifecycle' | 'createRouteAdmission'>
): Promise<HostedOperatorProductionComposition | null> {
  const nativeHandle = await takeHostedNativeActivationHandle(dependencies.ownerAdmission);
  if (nativeHandle && dependencies.inheritedCandidateActivation) {
    closeHostedApprovalRuntimeConnectedTransport(nativeHandle.transport);
    throw new Error('hosted-native-activation-duplicate-composition-input');
  }
  const inheritedCandidate = nativeHandle ?? dependencies.inheritedCandidateActivation;
  let producerProvenance: ReturnType<typeof createHostedProducerProvenanceFromEnvironment>;
  try {
    producerProvenance = createHostedProducerProvenanceFromEnvironment(environment, {
      role: 'product-producer', modulePath: __filename,
    });
  } catch (error) {
    if (inheritedCandidate) closeHostedApprovalRuntimeConnectedTransport(inheritedCandidate.transport);
    throw error;
  }
  if (nativeHandle) {
    let runtime: HostedApprovalGenerationRuntime | undefined;
    try {
      if (!generationRuntime || !producerProvenance) throw new Error('native_generation_runtime_required');
      const activationPublication = readHostedApprovalRuntimeActivationPublicationContract(environment);
      runtime = new HostedApprovalGenerationRuntime({
        ...generationRuntime,
        dependencies: { ...dependencies, activationPublication },
        initial: { selection: nativeHandle.selection, socket: nativeHandle.transport.socket },
        serializedBootstrap: environment.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP ?? '',
        provenance: producerProvenance,
        sseEmitter: createProductHostedProducerSseWriteEmitter(environment),
        send: message => new Promise<void>((resolve, reject) => {
          if (!process.send || !process.connected) { reject(new Error('native_generation_ipc_lost')); return; }
          process.send(message, error => error ? reject(error) : resolve());
        }),
      });
      installHostedNativeActivationReplacementReceiver(runtime);
      await runtime.start();
      return runtime;
    } catch (error) {
      closeHostedApprovalRuntimeConnectedTransport(nativeHandle.transport);
      if (runtime) runtime.close(); else producerProvenance?.close();
      throw error;
    }
  }
  try {
    installProductHostedProducerProvenance(
      producerProvenance,
      createProductHostedProducerSseWriteEmitter(environment)
    );
  } catch (error) {
    producerProvenance?.close();
    if (inheritedCandidate) closeHostedApprovalRuntimeConnectedTransport(inheritedCandidate.transport);
    throw error;
  }
  const candidateActivation =
    inheritedCandidate === undefined
      ? undefined
      : Object.freeze({
          transport: Object.freeze({ socket: inheritedCandidate.transport.socket }),
          expectedOpenCodeExecutableSha256: inheritedCandidate.expectedOpenCodeExecutableSha256,
        });
  try {
    const activationPublication =
      readHostedApprovalRuntimeActivationPublicationContract(environment);
    const hostedProductionEnabled =
      inheritedCandidate !== undefined ||
      (dependencies.ownerAdmission !== null &&
        dependencies.ownerAdmission.approvalRoutes.length > 0 &&
        dependencies.routeDependencies !== null &&
        dependencies.actorId !== null &&
        dependencies.ownerProofKey !== null &&
        activationPublication !== null);
    if (hostedProductionEnabled && producerProvenance === null) {
      throw new TypeError('hosted-production-producer-provenance-required');
    }
    const composition = await createOptionalHostedApprovalProductionComposition({
      ...dependencies,
      ...(candidateActivation === undefined
        ? {}
        : { inheritedCandidateActivation: candidateActivation }),
      activationPublication,
      ...(producerProvenance === null ? {} : { producerProvenance }),
    });
    if (composition === null && producerProvenance !== null) {
      producerProvenance.close();
      clearProductHostedProducerProvenance(producerProvenance);
    }
    return composition;
  } catch (error) {
    if (candidateActivation !== undefined) {
      closeHostedApprovalRuntimeConnectedTransport(candidateActivation.transport);
    }
    if (producerProvenance !== null) {
      producerProvenance.close();
      clearProductHostedProducerProvenance(producerProvenance);
    }
    throw error;
  }
}
