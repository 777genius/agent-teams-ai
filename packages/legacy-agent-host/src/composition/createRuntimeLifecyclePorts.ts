import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { MemberEntry } from './MemberEntry.js';
import type { TeamRuntimeDeliveryPort } from '../team/contracts.js';

/** Original captured cleanup only; no selection, generation allocation, input admission or native retry. */
export function createRuntimeLifecyclePorts(options: {
  runtime: RuntimeOwner; entries: ReadonlyMap<string, MemberEntry>; delivery: TeamRuntimeDeliveryPort;
  assertWriter(): void; closeEndpoint(entry: MemberEntry): Promise<void>;
}) {
  return {
    delivery: options.delivery,
    runtime: {
      readCapturedSession: options.runtime.readCapturedSession.bind(options.runtime),
      async stopCapturedSession(binding: Parameters<RuntimeOwner['stopCapturedSession']>[0]) {
        options.assertWriter();
        const entry = options.entries.get(runtimeDigest(binding));
        const result = await options.runtime.stopCapturedSession(binding);
        options.assertWriter();
        if (entry) {
          if (entry.provider && !(await entry.provider.cleanup())) throw new RuntimeOwnerError('hold');
          await options.closeEndpoint(entry);
        }
        options.assertWriter();
        return result;
      },
    },
  };
}
