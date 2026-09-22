import { productActivationSigningEnvironment } from './selected-product-signing-reference';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import type { ProcessExitEvidence, SupervisorPlan } from '../processes';
import { decodeNativeActivationHandleSelection,
  type NativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';
import { canonicalJson, sha256 } from './canonical';
import { SelectedCapture } from './selected-capture';
import { loadSelectedKernel, retainSelectedProcess, type SelectedProcessHandle } from './selected-kernel';
import { assertSelectedPlanAdmission, type SelectedPlanAdmission } from './selected-plan-admission';
import { decodeSelectedPrivateInputs, type SelectedPrivateInputs } from './selected-private-inputs';
import { drainSelectedProcess, SELECTED_PROCESS_LIFETIME } from './selected-process-drain';
import { observeSelectedDirectProducer, observeSelectedDirectProducerExit } from './selected-producer-observation';
import { readReadonlyArtifact } from './readonly-artifact';

function check(value: unknown): asserts value { if (!value) throw new Error('selected_product_runtime'); }

/** Initial Product launch only, called with the native launch's actual selected
 * handle binding. This starts the existing selected Product module and its IPC
 * receiver. IPC ownership/adoption and HTTP readiness remain separate waits;
 * this function never reports a generation ready merely because it spawned. */
export async function startSelectedProduct(plan: SupervisorPlan, admission: SelectedPlanAdmission,
  input: SelectedPrivateInputs, selectedHandle: NativeActivationHandleSelection, signal: AbortSignal) {
  try { return await startPrivate(plan, admission, input, selectedHandle, signal); }
  catch { throw new Error('selected_product_start_failed'); }
}

async function startPrivate(plan: SupervisorPlan, admission: SelectedPlanAdmission,
  input: SelectedPrivateInputs, selectedHandle: NativeActivationHandleSelection, signal: AbortSignal) {
  assertSelectedPlanAdmission(admission, plan);
  const selected = decodeSelectedPrivateInputs(input, plan);
  const selection = decodeNativeActivationHandleSelection(selectedHandle);
  check(plan.productSourceInvocation && plan.supervisorSourceInvocation && admission.kernelModule &&
    plan.supervisorAdmissionDescriptor && selection.ownerGeneration === 1 &&
    selection.ownerSessionId === selected.generations[0].common.ownerSessionId &&
    selection.bootstrapDigest === sha256(selected.serializedProductBootstrap) &&
    selection.expectedOpenCodeExecutableSha256 === plan.expectedExecutableSha256.opencode);
  const module = plan.supervisorAdmissionDescriptor.product.compositionEntry;
  check(plan.productSourceInvocation.module.path === `/product/${module.relativePath}` &&
    plan.productSourceInvocation.module.sha256 === module.sha256);
  const root = openSync('/product', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const bytes = readReadonlyArtifact(root, module, 32 * 1024 * 1024); bytes.fill(0); }
  finally { closeSync(root); }
  const kernel = loadSelectedKernel(admission.kernelModule);
  const marker = randomBytes(32).toString('hex');
  const captures: SelectedCapture[] = [];
  let child: ChildProcess | undefined;
  let handle: SelectedProcessHandle | undefined;
  let childExit: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> | undefined;
  try {
    const ledger = new SelectedCapture(plan, 'conditionalPostLedgerPath', 'product-1'); captures.push(ledger);
    const timeline = new SelectedCapture(plan, 'productTimelinePath', 'product-1'); captures.push(timeline);
    check(ledger.fd === 9 && timeline.fd === 10);
    const streams = { conditionalPostLedger: ledger.publicBinding(), productTimeline: timeline.publicBinding() };
    const contract = plan.runtimeManifest.captureEmissionContract;
    const capsule = canonicalJson({ activation: { controllerNonce: plan.controllerNonce, runId: plan.runId,
      stackManifestSha256: selected.openCode.stackManifestSha256 }, contract: contract.contract,
      contractSha256: contract.contractSha256, expectedProducer: {
        artifactManifestSha256: plan.expectedProducerArtifactSha256.product,
        executableSha256: plan.expectedExecutableSha256.product,
        implementationId: 'agent-teams.product.hosted-approval.v1', moduleSha256: plan.expectedProducerModuleSha256.product,
      }, producerRole: 'product-producer', streams, version: 2 });
    const stdio: StdioOptions = ['ignore', 'ignore', 'ignore', 'ipc'];
    for (const capture of captures) {
      while (stdio.length <= capture.fd) stdio.push('ignore');
      stdio[capture.fd] = capture.sourceFd;
    }
    assertSelectedPlanAdmission(admission, plan); signal.throwIfAborted();
    child = spawn(`/toolchain/${plan.supervisorSourceInvocation.executable.relativePath}`,
      [...plan.expectedArgv.product], { cwd: '/sandbox/project', shell: false, stdio,
        env: { ...selected.productEnvironment, ...productActivationSigningEnvironment(selected.productActivationSigning), HOST: '127.0.0.1', PORT: '45131',
          AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: selected.serializedProductBootstrap,
          [SELECTED_PROCESS_LIFETIME]: marker,
          [plan.processOwnership.environmentKey]: plan.processOwnership.marker,
          [contract.environment]: capsule } });
    childExit = new Promise((resolve, reject) => {
      child!.once('exit', (code, exitSignal) => resolve(Object.freeze({ code, signal: exitSignal })));
      child!.once('error', () => reject(new Error('selected_product_spawn')));
    });
    void childExit.catch(() => undefined);
    const spawnBoundary = process.hrtime.bigint().toString();
    check(child.pid);
    handle = retainSelectedProcess(kernel, child.pid);
    const parentWriterClosures = captures.map(capture =>
      capture.directSpawnClosed(admission.process.processStartToken, spawnBoundary));
    await new Promise<void>((resolve, reject) => {
      child!.once('spawn', resolve);
      child!.once('error', () => reject(new Error('selected_product_spawn')));
    });
    const observation = await observeSelectedDirectProducer(plan, admission, 'product', handle, signal);
    for (const capture of captures) capture.observeDirectProducer(observation, handle);
    check(child.connected && !handle.isExited());
    const processHandle = handle;
    const waitedExit = childExit;
    let closePromise: Promise<Awaited<ReturnType<typeof drainSelectedProcess>>> | undefined;
    let exitObservation: ProcessExitEvidence | undefined;
    return Object.freeze({ child, processHandle, processObservation: observation, exit: waitedExit,
      captures: Object.freeze({ conditionalPostLedger: ledger, productTimeline: timeline }),
      parentWriterClosures: Object.freeze(parentWriterClosures),
      close() {
        return closePromise ??= (async () => {
          const exits = await drainSelectedProcess(kernel, processHandle, marker, admission.process.pidNamespaceInode);
          await waitedExit;
          exitObservation = observeSelectedDirectProducerExit(plan, admission, observation, processHandle);
          return exits;
        })();
      },
      exitObservation() { check(exitObservation); return exitObservation; },
      releaseObservation() {
        check(exitObservation);
        try { processHandle.close(); }
        finally { for (const capture of captures) capture.close(); }
      },
    });
  } catch {
    try {
      if (handle) {
        await drainSelectedProcess(kernel, handle, marker, admission.process.pidNamespaceInode);
        await childExit;
      }
    } finally {
      try { handle?.close(); }
      finally { for (const capture of captures) capture.close(); }
    }
    throw new Error('selected_product_start_failed');
  }
}
