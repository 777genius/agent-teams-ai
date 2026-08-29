import {
  clearProductHostedProducerProvenance,
  createHostedProducerProvenanceFromEnvironment,
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

import type { HostedOperatorProductionComposition } from './hostedOperatorProductionComposition';

/** Loads the pinned activation publication before applying the optional hosted composition gates. */
export async function createHostedApprovalProductionCompositionFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: Omit<
    CreateOptionalHostedApprovalProductionCompositionDependencies,
    'activationPublication'
  >
): Promise<HostedOperatorProductionComposition | null> {
  const inheritedCandidate = dependencies.inheritedCandidateActivation;
  const producerProvenance = createHostedProducerProvenanceFromEnvironment(environment, {
    role: 'product-producer',
    modulePath: __filename,
  });
  try {
    installProductHostedProducerProvenance(producerProvenance);
  } catch (error) {
    producerProvenance?.close();
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
