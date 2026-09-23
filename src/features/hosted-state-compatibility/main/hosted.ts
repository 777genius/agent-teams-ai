import {
  createHostedStateCompatibilityAdmission,
  type HostedStateCompatibilityAdmissionOptions,
} from './composition/createHostedStateCompatibilityAdmission';
import { createNodeHostedStateCompatibilityRuntime } from './infrastructure/createNodeHostedStateCompatibilityRuntime';

/** Production-only constructor; never exported from the cross-feature general entrypoint. */
export function createNodeHostedStateCompatibilityAdmission(
  options: Omit<HostedStateCompatibilityAdmissionOptions, 'runtime'>
) {
  return createHostedStateCompatibilityAdmission({
    ...options,
    runtime: createNodeHostedStateCompatibilityRuntime(),
  });
}
