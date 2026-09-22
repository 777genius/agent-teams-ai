import type { NativeActivationSocketIdentity } from '../../../../src/main/composition/hosted/hostedNativeActivationSocketIdentity';
import type { NativeActivationHandleSelection } from '../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';
import type { ChildProcess } from 'node:child_process';
import type { SupervisorPlan } from '../processes';
import { canonicalJson } from './canonical';
import { launchOwnerFromPlan } from './index';
import { ROOT_PROCESS_SCHEDULE } from './launch-schedule';
import { withSelectedOwnerInputs, type PreparedSelectedOwnerInputs } from './selected-owner-inputs';
import { assertSelectedPlanAdmission, type SelectedPlanAdmission } from './selected-plan-admission';
import { materializeSelectedRuntimeManifest } from './selected-runtime-manifest';
import { prepareProductGenerationTransition, readProductGenerationAdoption } from './product-generation-transition';
import { startSelectedProduct } from './selected-product-runtime';
import { startSelectedOpenCode } from './selected-opencode-runtime';
import type { SelectedControllerClient } from './selected-controller-client';

type OwnerLaunch = Awaited<ReturnType<typeof launchOwnerFromPlan>>;
type ProductRuntime = Awaited<ReturnType<typeof startSelectedProduct>>;
type ProductCleanup = PromiseSettledResult<Awaited<ReturnType<ProductRuntime['close']>>>;
type OpenCodeRuntime = Awaited<ReturnType<typeof startSelectedOpenCode>>;
type OpenCodeCleanup = PromiseSettledResult<Awaited<ReturnType<OpenCodeRuntime['close']>>>;
type Step = (typeof ROOT_PROCESS_SCHEDULE)[number];
type OwnerStep = Extract<Step, { role: 'owner' }>;
type ReplacementStep = Exclude<OwnerStep, { generation: 1 }>;
type ReplacementReap = Readonly<{
  instanceId: OwnerStep['instanceId'];
  generation: OwnerStep['generation'];
  ownerProcessStartToken: string;
  exit: Awaited<OwnerLaunch['exit']>;
}>;

/** The selected entry's concrete observation/custody operations. These are not
 * evidence supplied by a plan. Each wait observes its actual owned process or
 * authenticated scenario boundary, and must reject loss of that relationship. */
export interface SelectedScheduleOperations {
  /** Supplies live OpenCode/bootstrap/raw-custody inputs. Ownership of returned
   * writers transfers to the concrete in-tree input scope below. */
  prepareOwnerInputs(step: OwnerStep, openCode: OpenCodeRuntime): Promise<PreparedSelectedOwnerInputs>;
  waitOwnerReady(step: OwnerStep, launch: OwnerLaunch): Promise<void>;
  waitProductReady(step: Extract<Step, { role: 'product' }>, product: ChildProcess): Promise<void>;
  /** Observe the existing Product's independently admitted successor binding
   * after its old authority was revoked/drained. The IPC ownership reply and
   * Owner readiness do not establish Product generation readiness. */
  waitProductGenerationReady(step: ReplacementStep, product: ChildProcess, launch: OwnerLaunch): Promise<void>;
  startBrowser(step: Extract<Step, { role: 'browser' }>): Promise<void>;
  waitReplacementBoundary(step: ReplacementStep, previous: OwnerLaunch): Promise<void>;
  /** Revoke dispatch, stop/drain exact generation writers and retain its seal
   * before resolving. A native child exit alone does not discharge this step. */
  retireOwner(step: ReplacementStep, previous: OwnerLaunch): Promise<void>;
  ownerLaunched(step: OwnerStep, launch: OwnerLaunch): Promise<void>;
  finishBrowser(): Promise<void>;
}

/** Fixed existing seven-start schedule. This retains actual launch results for
 * transcript/custody production; it does not infer readiness, seals or scenario
 * success from the schedule itself. Product is created by the initial native
 * launch's real Node IPC callback and reused for every replacement. */
export async function runSelectedSchedule(
  plan: SupervisorPlan,
  admission: SelectedPlanAdmission,
  operations: SelectedScheduleOperations,
  signal: AbortSignal,
  controller: SelectedControllerClient,
) {
  const selectedPlan = structuredClone(plan);
  assertSelectedPlanAdmission(admission, selectedPlan);
  if (controller.admission !== admission || canonicalJson(controller.plan) !== canonicalJson(selectedPlan)) {
    throw new Error('selected_supervisor_controller_selection');
  }
  if (canonicalJson(selectedPlan.startSchedule) !== canonicalJson(ROOT_PROCESS_SCHEDULE)) {
    throw new Error('selected_supervisor_schedule_changed');
  }
  const launches: { step: OwnerStep; launch: OwnerLaunch }[] = [];
  const replacementReaps: ReplacementReap[] = [];
  let product: ChildProcess | undefined;
  let productRuntime: ProductRuntime | undefined;
  let openCodeRuntime: OpenCodeRuntime | undefined;
  let previous: OwnerLaunch | undefined;
  let manifest: ReturnType<typeof materializeSelectedRuntimeManifest> | undefined;
  // Retain bound implementations before the first await. A caller mutating an
  // adapter object later cannot switch an admitted operation mid-generation.
  const prepareOwnerInputs = operations.prepareOwnerInputs.bind(operations);
  const waitOwnerReady = operations.waitOwnerReady.bind(operations);
  const waitProductReady = operations.waitProductReady.bind(operations);
  const waitProductGenerationReady = operations.waitProductGenerationReady.bind(operations);
  const startBrowser = operations.startBrowser.bind(operations);
  const waitReplacementBoundary = operations.waitReplacementBoundary.bind(operations);
  const retireOwner = operations.retireOwner.bind(operations);
  const ownerLaunched = operations.ownerLaunched.bind(operations);
  const finishBrowser = operations.finishBrowser.bind(operations);
  const selectedPrivateInputs = await controller.privateInputs();
  try {
    manifest = materializeSelectedRuntimeManifest(selectedPlan, admission);
    for (const step of ROOT_PROCESS_SCHEDULE) {
      signal.throwIfAborted();
      if (step.role === 'opencode') {
        if (openCodeRuntime || !admission.preparationModule) throw new Error('selected_supervisor_opencode_selection');
        openCodeRuntime = await startSelectedOpenCode(selectedPlan, admission,
          { ...selectedPrivateInputs.openCode, preparationModule: admission.preparationModule }, signal);
        continue;
      }
      if (step.role === 'product') {
        if (!product) throw new Error('selected_supervisor_product_not_transferred');
        await waitProductReady(step, product); continue;
      }
      if (step.role === 'browser') { await startBrowser(step); continue; }
      if (step.generation !== 1) {
        if (!previous) throw new Error('selected_supervisor_predecessor_missing');
        await waitReplacementBoundary(step, previous);
        signal.throwIfAborted();
        if (!product) throw new Error('selected_supervisor_product_missing');
        if (!previous.activationHandleTransfer) throw new Error('selected_supervisor_predecessor_adoption_missing');
        const predecessor = readProductGenerationAdoption(product, previous.activationHandleTransfer.selection);
        const ticket = await controller.transition(step.generation, previous.ownerProcessStartToken,
          predecessor.manifestDigest, selectedPrivateInputs.generations[0].common.bootstrapBinding.bootstrapDigest);
        await prepareProductGenerationTransition(product, ticket, step.generation, signal);
        await retireOwner(step, previous);
        // Retain the native wait status too. Do not substitute a fabricated
        // exit record for the helper's actual reap result.
        const exit = await previous.exit;
        const predecessorLaunch = launches.at(-1);
        if (!predecessorLaunch || predecessorLaunch.launch !== previous) {
          throw new Error('selected_supervisor_predecessor_record_missing');
        }
        replacementReaps.push(Object.freeze({
          instanceId: predecessorLaunch.step.instanceId,
          generation: predecessorLaunch.step.generation,
          ownerProcessStartToken: previous.ownerProcessStartToken,
          exit: Object.freeze({ ...exit }),
        }));
      }
      signal.throwIfAborted();
      let invoked = false;
      let created: OwnerLaunch | undefined;
      if (!openCodeRuntime) throw new Error('selected_supervisor_opencode_missing');
      const prepared = await prepareOwnerInputs(step, openCodeRuntime);
      const launch = await withSelectedOwnerInputs(selectedPlan, admission, prepared, async inputs => {
        manifest!.assertCurrent();
        if (invoked) throw new Error('selected_supervisor_launch_callback_reused');
        invoked = true;
        const ipc = inputs.activationHandleIpc;
        if (!ipc || canonicalJson(inputs.plan) !== canonicalJson(selectedPlan) ||
          inputs.bootstrap.common.ownerGeneration !== step.generation) {
          throw new Error('selected_supervisor_owner_inputs');
        }
        if (product && (product.exitCode !== null || product.signalCode !== null || !product.connected)) {
          throw new Error('selected_supervisor_product_lost');
        }
        created = await launchOwnerFromPlan({ ...inputs, plan: selectedPlan, signal,
          activationHandleIpc: { ...ipc, nativeController: controller,
            ...(step.generation === 1 ? {} : { authorizeSuccessorHandle: (selection: NativeActivationHandleSelection, endpoint: NativeActivationSocketIdentity) =>
              controller.successorHandle(selection, endpoint) }),
            selectedArtifacts: { ...ipc.selectedArtifacts, runtimeManifestSha256: manifest!.sha256 },
            product: async selection => {
              if (product) return product;
              if (step.generation !== 1 || productRuntime) throw new Error('selected_supervisor_product_replaced');
              productRuntime = await startSelectedProduct(selectedPlan, admission, selectedPrivateInputs, selection, signal);
              product = productRuntime.child;
              return product;
            } },
        });
        // Retain before the input owner releases its borrowed handles: cleanup
        // failure there must not hide a successfully executed Owner.
        launches.push({ step, launch: created });
        return created;
      });
      if (!created || launch !== created) throw new Error('selected_supervisor_launch_result_substituted');
      previous = launch;
      await ownerLaunched(step, launch);
      await waitOwnerReady(step, launch);
      if (!launch.activationHandleTransfer) throw new Error('selected_supervisor_product_adoption_missing');
      await launch.activationHandleTransfer.waitForAdoption();
      if (step.generation !== 1) {
        signal.throwIfAborted();
        if (!product || product.exitCode !== null || product.signalCode !== null || !product.connected) {
          throw new Error('selected_supervisor_product_lost');
        }
        await waitProductGenerationReady(step, product, launch);
        signal.throwIfAborted();
        if (product.exitCode !== null || product.signalCode !== null || !product.connected) {
          throw new Error('selected_supervisor_product_lost');
        }
      }
    }
    await finishBrowser();
    signal.throwIfAborted();
    manifest.assertCurrent();
    // Close within the evidence-preserving try. A failing final close must not
    // replace retained native launch observations from the failure path.
    manifest.close();
    return Object.freeze({
      launches: Object.freeze(launches.map(row => Object.freeze(row))),
      replacementReaps: Object.freeze([...replacementReaps]),
      runtimeManifest: Object.freeze({ path: manifest.path, sha256: manifest.sha256,
        device: manifest.device, inode: manifest.inode, size: manifest.size }),
      product: product!,
      productRuntime: productRuntime!,
      openCodeRuntime: openCodeRuntime!,
    });
  } catch (cause) {
    // Preserve native observations even when later readiness, a replacement or
    // browser work fails. Dispose only the Owner/Product launches created by
    // this schedule; enclosing custody retains captures and finalization.
    const cleanup = await Promise.allSettled(launches.map(({ launch }) => launch.dispose()));
    const productCleanup = productRuntime ? (await Promise.allSettled([productRuntime.close()]))[0] : undefined;
    const openCodeCleanup = openCodeRuntime ? (await Promise.allSettled([openCodeRuntime.close()]))[0] : undefined;
    let manifestCleanup: PromiseSettledResult<void> | undefined;
    if (manifest) {
      try { manifest.close(); manifestCleanup = { status: 'fulfilled', value: undefined }; }
      catch (reason) { manifestCleanup = { status: 'rejected', reason }; }
    }
    throw new SelectedScheduleFailure(cause, Object.freeze(launches.map(({ step, launch }) =>
      Object.freeze({ instanceId: step.instanceId, generation: step.generation,
        held: launch.held, sealed: launch.sealed, executed: launch.executed,
        parentWriterClosures: launch.parentWriterClosures,
        ownerProcessStartToken: launch.ownerProcessStartToken,
        evidence: launch.launchEvidence(),
      }))), cleanup, Object.freeze([...replacementReaps]), manifest && Object.freeze({
        path: manifest.path, sha256: manifest.sha256, device: manifest.device,
        inode: manifest.inode, size: manifest.size,
      }), manifestCleanup, productRuntime, productCleanup, openCodeRuntime, openCodeCleanup);
  }
}

export class SelectedScheduleFailure extends Error {
  constructor(cause: unknown,
    readonly retainedLaunches: readonly Readonly<{
      instanceId: string; generation: number;
      held: OwnerLaunch['held']; sealed: OwnerLaunch['sealed']; executed: OwnerLaunch['executed'];
      parentWriterClosures: OwnerLaunch['parentWriterClosures'];
      ownerProcessStartToken: string; evidence: ReturnType<OwnerLaunch['launchEvidence']>;
    }>[],
    readonly cleanup: readonly PromiseSettledResult<void>[],
    /** Only actual awaited native reaps at replacement boundaries. Cleanup
     * completion and a pending final-generation exit do not create records. */
    readonly replacementReaps: readonly ReplacementReap[],
    readonly runtimeManifest: Readonly<{
      path: '/sandbox/runtime-manifest.json'; sha256: string; device: string; inode: string; size: number;
    }> | undefined,
    readonly manifestCleanup: PromiseSettledResult<void> | undefined,
    readonly productRuntime?: ProductRuntime,
    readonly productCleanup?: ProductCleanup,
    readonly openCodeRuntime?: OpenCodeRuntime,
    readonly openCodeCleanup?: OpenCodeCleanup,
  ) {
    super('selected_supervisor_schedule_failed', { cause });
    this.name = 'SelectedScheduleFailure';
  }
}
