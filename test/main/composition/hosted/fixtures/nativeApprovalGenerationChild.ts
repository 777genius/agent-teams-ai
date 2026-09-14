import { createPrivateKey } from 'node:crypto';

import { HostedApprovalGenerationRuntime } from '../../../../../src/main/composition/hosted/hostedApprovalGenerationRuntime';
import { installHostedNativeActivationReplacementReceiver, takeHostedNativeActivationHandle } from '../../../../../src/main/composition/hosted/hostedNativeActivationHandle';

import { generationFixture } from './approvalGenerationFixture';

// Test-only storage/permission ports and keys; actual production construction,
// native Node handle reception, signed transitions, activation and loss handling.
const fixture = generationFixture(createPrivateKey(process.argv[3]!));
let runtime: HostedApprovalGenerationRuntime | undefined;
const fail = (error?: unknown) => {
  console.error('approval-generation-child failed', error);
  process.exitCode = 1;
  runtime?.close();
  if (process.connected) process.disconnect();
};
try {
  process.send!({ fixture: 'approval-generation-child', first: fixture.selection(1),
    second: fixture.selection(2), ticket: fixture.ticket(), successorManifest: fixture.manifest(2) });
  const first = await takeHostedNativeActivationHandle(fixture.input.ownerAdmission);
  if (!first) throw new Error('native child entry required');
  runtime = new HostedApprovalGenerationRuntime({
    dependencies: { ...fixture.input, onApprovalOwnerLoss: fail },
    createRouteAdmission: fixture.createRouteAdmission,
    initial: { socket: first.transport.socket, selection: first.selection },
    serializedBootstrap: fixture.bootstrap, provenance: fixture.writer,
    sseEmitter: () => true, drainStreams: async operation => operation(), revokeLifecycle: () => {},
    send: message => new Promise<void>((resolve, reject) => {
      process.send!(message, error => error ? reject(error) : resolve());
    }),
  });
  installHostedNativeActivationReplacementReceiver(runtime);
  await runtime.start();
} catch (error) { fail(error); }
