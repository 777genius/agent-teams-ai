import { readHostedApprovalRuntimeActivationPublicationContract } from '../../services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';

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
  const activationPublication = readHostedApprovalRuntimeActivationPublicationContract(environment);
  return createOptionalHostedApprovalProductionComposition({
    ...dependencies,
    activationPublication,
  });
}
