import { takeHostedNativeActivationHandle } from '../../../../../src/main/composition/hosted/hostedNativeActivationHandle';

import type { HostedLifecycleProductionOwnerAdmission } from '../../../../../src/main/composition/hosted/hostedLifecycleProductionOwnerAdmission';

// A test-only independently selected admission tuple. No production credentials,
// expected provider output, root selection or native eligibility is represented.
const selected = JSON.parse(process.argv[3]!) as HostedLifecycleProductionOwnerAdmission;
const supervisorDisconnected = once(process, 'disconnect');
try {
  const received = await takeHostedNativeActivationHandle(selected);
  if (!received) throw new Error('receiver not selected');
  await new Promise<void>(resolve => received.transport.socket.end('actual transferred endpoint', resolve));
} catch {
  process.exitCode = 1;
} finally {
  // Retain actual process identity until the supervisor has observed transfer
  // ownership. This is test teardown, not an activation acknowledgment.
  await supervisorDisconnected;
}
import { once } from 'node:events';
