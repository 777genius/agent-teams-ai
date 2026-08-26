import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseRunArguments } from './contracts';
import { runDriver } from './driver';
import {
  assembleEvidence,
  deriveEvidence,
  retainEvidence,
  retainFailureEvidence,
} from './evidence';
import {
  admitIntegration,
  closeAdmission,
  consumeOneRunAuthorization,
  readIntegrationDescriptor,
  type PreflightAdmission,
} from './preflight';
import { cleanupSandbox, createSandbox, type DisposableSandbox } from './sandbox';

export interface RunResult {
  readonly terminalState: 'HOLD';
  readonly evidenceDigest: string;
}

export async function run(arguments_: readonly string[]): Promise<RunResult> {
  parseRunArguments(arguments_);
  const descriptor = await readIntegrationDescriptor();
  let admission: PreflightAdmission | undefined;
  let sandbox: DisposableSandbox | undefined;
  let zeroOwnedSurvivors = false;
  let sandboxRemoved = false;
  try {
    admission = await admitIntegration(descriptor, fileURLToPath(import.meta.url));
    const consumedAttempt = await consumeOneRunAuthorization(admission);
    sandbox = await createSandbox(admission.roots.sandboxParent, descriptor.controllerNonce);
    const driver = await runDriver(admission, sandbox, consumedAttempt);
    zeroOwnedSurvivors = driver.outcome.zeroOwnedSurvivors;
    deriveEvidence(driver.raw, descriptor.controllerNonce, driver.outcome);
    const cleanup = await cleanupSandbox(sandbox, zeroOwnedSurvivors);
    sandboxRemoved = cleanup.disposition === 'removed';
    const document = assembleEvidence({
      raw: driver.raw,
      controllerNonce: descriptor.controllerNonce,
      runId: sandbox.runId,
      outcome: driver.outcome,
      cleanup,
    });
    await retainEvidence(
      admission.roots.evidenceRoot,
      driver.raw,
      document,
      driver.outcome.transcript
    );
    return Object.freeze({
      terminalState: 'HOLD',
      evidenceDigest: document.evidenceDigest,
    });
  } catch (error) {
    if (admission) {
      if (sandbox && !sandboxRemoved) await cleanupSandbox(sandbox, false);
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
