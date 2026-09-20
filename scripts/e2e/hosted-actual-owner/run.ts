import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseRunArguments } from './contracts';
import { prepareDriverExecution, runDriver, type PreparedDriverExecution } from './driver';
import { prepareEvidence, retainFailureEvidence } from './evidence';
import {
  admitIntegration,
  closeAdmission,
  consumeOneRunAuthorization,
  readIntegrationDescriptor,
  type PreflightAdmission,
} from './preflight';
import { cleanupSandbox, createSandbox, type DisposableSandbox } from './sandbox';
import { assertSelectedControllerInputPresence } from './selected-controller-inputs';
import type { SelectedControllerExecutionInputs } from './supervisor/selected-controller-execution';

export interface RunResult {
  readonly terminalState: 'HOLD';
  readonly evidenceDigest: string;
}

export async function run(
  arguments_: readonly string[],
  selectedInputs?: SelectedControllerExecutionInputs
): Promise<RunResult> {
  parseRunArguments(arguments_);
  const descriptor = await readIntegrationDescriptor();
  let admission: PreflightAdmission | undefined;
  let sandbox: DisposableSandbox | undefined;
  let zeroOwnedSurvivors = false;
  let sandboxRemoved = false;
  let authorizationConsumed = false;
  try {
    admission = await admitIntegration(descriptor, fileURLToPath(import.meta.url));
    let preparedExecution: PreparedDriverExecution | undefined;
    let consumedAttempt: Awaited<ReturnType<typeof consumeOneRunAuthorization>>;
    if (admission.ownerLaunch) {
      assertSelectedControllerInputPresence(true, selectedInputs);
      sandbox = await createSandbox(admission.roots.sandboxParent, descriptor.controllerNonce);
      preparedExecution = prepareDriverExecution(admission, sandbox, selectedInputs);
      // Authentication is the destructive-cleanup boundary: authorization consumption may
      // durably write before a later synchronization or validation failure is reported.
      authorizationConsumed = true;
      consumedAttempt = await consumeOneRunAuthorization(admission);
    } else {
      // Preserve the legacy ordering: spend authorization before sandbox
      // creation or supervisor planning.
      consumedAttempt = await consumeOneRunAuthorization(admission);
      authorizationConsumed = true;
      assertSelectedControllerInputPresence(false, selectedInputs);
      sandbox = await createSandbox(admission.roots.sandboxParent, descriptor.controllerNonce);
    }
    const driver = await runDriver(admission, sandbox, consumedAttempt, preparedExecution);
    zeroOwnedSurvivors = driver.outcome.zeroOwnedSurvivors;
    const prepared = prepareEvidence({
      ...driver,
      controllerNonce: descriptor.controllerNonce,
      runId: sandbox.runId,
    });
    const cleanup = await cleanupSandbox(sandbox, zeroOwnedSurvivors);
    sandboxRemoved = cleanup.disposition === 'removed';
    const document = prepared.assemble(cleanup);
    await prepared.retain(admission.roots.evidenceRoot, document);
    return Object.freeze({
      terminalState: 'HOLD',
      evidenceDigest: document.evidenceDigest,
    });
  } catch (error) {
    if (admission) {
      if (sandbox && !sandboxRemoved) {
        const cleanup = await cleanupSandbox(sandbox, !authorizationConsumed);
        sandboxRemoved = cleanup.disposition === 'removed';
      }
      await retainFailureEvidence(
        admission.roots.evidenceRoot,
        descriptor.controllerNonce,
        sandbox?.runId ?? null,
        error
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (sandbox && !sandboxRemoved) {
      await sandbox.handle.close().catch(() => undefined);
    }
    if (admission) await closeAdmission(admission);
  }
}

async function main(): Promise<void> {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error: unknown) => {
    const reason =
      error instanceof Error && /^[a-z0-9_:.-]{1,256}$/iu.test(error.message)
        ? error.message
        : 'p3c_run_failed';
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
  });
}
