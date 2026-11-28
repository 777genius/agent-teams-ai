import { MAX_RUNTIME_INPUT_BYTES, RuntimeOwnerError } from '../runtime/contracts.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { runtimeInputFits } from '../runtime/runtimeDelivery.js';
import { projectMemberInput } from './projectMemberInput.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeBinding, RuntimeDelivery } from '../runtime/contracts.js';
import type { TeamInputPreflight } from '../team/ports.js';
import type { MemberEntry } from './MemberEntry.js';

/** Existing delivery operations retain original capture availability and immutable identity. */
export function createRuntimeDeliveryPort(
  runtime: RuntimeOwner,
  assertAvailable: (binding: RuntimeBinding) => void
) {
  return {
    fingerprintDelivery: deliveryFingerprint,
    admitDelivery: (intent: RuntimeDelivery) => {
      assertAvailable(intent.binding);
      return runtime.admitDelivery(intent);
    },
    lookupDelivery: (intent: RuntimeDelivery) => {
      assertAvailable(intent.binding);
      return runtime.lookupDelivery(intent);
    },
    cancelDelivery: (...args: Parameters<RuntimeOwner['cancelDelivery']>) => {
      assertAvailable(args[0].binding);
      return runtime.cancelDelivery(...args);
    },
  };
}

/** Pure captured input validation before product publication or fresh Runtime admission. */
export function preflightMemberInput(options: {
  entry: MemberEntry;
  storageRoot: string;
  input: Parameters<TeamInputPreflight>[0];
  assertCurrent(): void;
}): boolean {
  const { entry, input } = options;
  options.assertCurrent();
  if (runtimeDigest(normalizeBinding(input.binding)) !== runtimeDigest(normalizeBinding(entry.binding)))
    throw new RuntimeOwnerError('forbidden');
  const limit = entry.profile.limits.inputBytes;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RUNTIME_INPUT_BYTES)
    throw new RuntimeOwnerError('hold');
  return runtimeInputFits(projectMemberInput(options).content, Math.min(MAX_RUNTIME_INPUT_BYTES, limit));
}
