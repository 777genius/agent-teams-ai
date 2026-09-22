import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import type { IntegrationDescriptor } from '../contracts';
import type { ControllerTrustAnchor } from '../controller-authority';
import { assertOwnerPlanV2 } from '../owner-plan';
import { verifyP3B2Recipe } from '../owner-recipe';
import type { SupervisorPlan } from '../processes';
import { canonicalJson, sha256 } from './canonical';
import { ROOT_PROCESS_SCHEDULE } from './launch-schedule';
import { SELECTED_PUBLIC_ARTIFACTS, SELECTED_PUBLIC_ARTIFACT_NAMES } from './public-artifacts';
import { readReadonlyArtifact } from './readonly-artifact';
import { admitSelectedControlDocuments } from './selected-control-admission';
import {
  assertSelectedSupervisorObservation,
  observeSelectedSupervisor,
} from './selected-process-observation';

const admittedPlans = new WeakMap<object, { plan: string; assertControlCurrent(): void }>();
export type SelectedPlanAdmission = Awaited<ReturnType<typeof admitSelectedSupervisorPlan>>;

function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`selected_supervisor_admission_${reason}`);
}

/** Namespace-local signed-control -> recipe -> selected process connection.
 * publicRoots MUST be imported from the independently provisioned payload
 * module by the executable. No roots are extracted from plan or descriptor.
 * This verifies launch selection, not capture custody or P1 qualification. */
export async function admitSelectedSupervisorPlan(
  publicRoots: ControllerTrustAnchor,
  descriptor: IntegrationDescriptor,
  plan: SupervisorPlan,
  signal: AbortSignal
) {
  const selected = structuredClone(descriptor),
    selectedPlan = structuredClone(plan);
  const selectedRoots = structuredClone(publicRoots);
  check(
    canonicalJson(selectedPlan.supervisorAdmissionDescriptor) === canonicalJson(selected),
    'descriptor_selection'
  );
  const roots: number[] = [];
  try {
    signal.throwIfAborted();
    const documents = openSync(
      '/admission',
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    roots.push(documents);
    const documentRoot = fstatSync(documents, { bigint: true });
    const control = admitSelectedControlDocuments(selectedRoots, selected, documents);
    const retainedControl = canonicalJson(control);
    const assertControlCurrent = () => {
      const current = openSync(
        '/admission',
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        const stat = fstatSync(current, { bigint: true });
        check(
          stat.dev === documentRoot.dev &&
            stat.ino === documentRoot.ino &&
            stat.mode === documentRoot.mode &&
            stat.uid === documentRoot.uid &&
            stat.gid === documentRoot.gid,
          'control_root_changed'
        );
        // Reopen and hash the exact readonly signed documents at consumption.
        // Cached successful admission is not current control authority after
        // an asynchronous preparation or a generation replacement boundary.
        check(
          canonicalJson(admitSelectedControlDocuments(selectedRoots, selected, current)) ===
            retainedControl,
          'control_changed'
        );
      } finally {
        closeSync(current);
      }
    };
    const publicFiles = Object.fromEntries(
      SELECTED_PUBLIC_ARTIFACT_NAMES.map((name) => {
        const pin = selected.control[name],
          mount = SELECTED_PUBLIC_ARTIFACTS[name];
        return [
          name,
          {
            descriptor: mount.fd,
            path: `/admission/${mount.name}`,
            device: pin.device,
            inode: pin.inode,
            size: pin.size,
            sha256: pin.sha256,
          },
        ];
      })
    );
    check(
      canonicalJson(selectedPlan.supervisorPublicArtifacts) ===
        canonicalJson({
          contract: 'agent-teams.hosted-selected-public-artifacts/v1',
          files: publicFiles,
        }),
      'public_mount_selection'
    );
    check(
      canonicalJson(selectedPlan.closures) ===
        canonicalJson({
          productRuntime: selected.product.runtimeClosure,
          browserBundle: selected.product.browserBundle,
          toolchain: selected.toolchain.closure,
          p3b2: selected.p3b2.closure,
        }),
      'closure_selection'
    );
    const payload = openSync(
      '/p3b2',
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    roots.push(payload);
    const recipeBytes = readReadonlyArtifact(payload, selected.p3b2.recipe, 16 * 1024 * 1024);
    const recipe = verifyP3B2Recipe(recipeBytes, selected);
    check(recipe?.supervisor && selectedPlan.supervisorSourceInvocation, 'recipe_v3_required');
    check(
      canonicalJson(selectedPlan.ownerPreparationModule ?? null) ===
        canonicalJson(recipe.preparationModule ?? null),
      'preparation_module_selection'
    );
    check(
      canonicalJson(selectedPlan.selectedKernelModule ?? null) ===
        canonicalJson(recipe.kernelModule ?? null),
      'kernel_module_selection'
    );
    check(
      selectedPlan.controllerNonce === selected.controllerNonce &&
        selectedPlan.runId === sha256(`agent-teams.p3c.run/v1\0${selected.controllerNonce}`) &&
        canonicalJson(selectedPlan.supervisorSourceInvocation) ===
          canonicalJson(recipe.supervisor) &&
        (recipe.compiled
          ? selectedPlan.ownerSourceInvocation === undefined
          : canonicalJson(selectedPlan.ownerSourceInvocation) === canonicalJson(recipe.source)) &&
        canonicalJson(selectedPlan.ownerLaunchHelper) === canonicalJson(recipe.helper) &&
        selectedPlan.ownerRecipeSha256 === recipe.recipeSha256 &&
        canonicalJson(selectedPlan.startSchedule) === canonicalJson(ROOT_PROCESS_SCHEDULE),
      'plan_selection'
    );
    check(
      canonicalJson(selectedPlan.expectedArgv.opencode) ===
        canonicalJson(['serve', '--hostname', '127.0.0.1', '--port', '4096']) &&
        canonicalJson(selectedPlan.expectedArgv.product) ===
          canonicalJson([
            `/product/${selected.product.compositionEntry.relativePath}`,
            '--hosted-native-activation-v1',
          ]),
      'producer_argv'
    );
    const images = {
      owner: recipe.executable,
      supervisor: recipe.supervisor.executable,
      opencode: selected.openCode.linuxX64Binary,
      product: selected.toolchain.node,
      browser: selected.toolchain.node,
    } as const;
    for (const role of Object.keys(images) as (keyof typeof images)[]) {
      const image = images[role];
      check(
        selectedPlan.expectedExecutableSha256[role] === image.sha256 &&
          selectedPlan.expectedExecutableDevice[role] === image.device &&
          selectedPlan.expectedExecutableInode[role] === image.inode,
        'plan_image'
      );
    }
    check(
      canonicalJson(selectedPlan.expectedProducerModuleSha256) ===
        canonicalJson({
          owner: selected.p3b2.entry.sha256,
          opencode: selected.openCode.identities.linuxX64BinarySha256,
          product: selected.product.compositionEntry.sha256,
          browser: selected.product.playwrightSpec.sha256,
        }) &&
        canonicalJson(selectedPlan.expectedProducerArtifactSha256) ===
          canonicalJson({
            owner: selected.p3b2.closure.manifestSha256,
            opencode: selected.openCode.identities.releaseManifestSha256,
            product: selected.product.runtimeClosure.manifestSha256,
            browser: selected.product.browserBundle.manifestSha256,
          }),
      'producer_selection'
    );
    assertOwnerPlanV2(selectedPlan);
    const observation = await observeSelectedSupervisor(recipe.supervisor, signal);
    const admission = Object.freeze({
      contract: 'agent-teams.hosted-selected-supervisor-admission/v1' as const,
      control,
      ...(recipe.preparationModule ? { preparationModule: recipe.preparationModule } : {}),
      ...(recipe.kernelModule ? { kernelModule: recipe.kernelModule } : {}),
      ownerExecutable: Object.freeze({ ...recipe.executable }),
      recipe: Object.freeze({
        path: `/p3b2/${selected.p3b2.recipe.relativePath}`,
        sha256: recipe.recipeSha256,
        device: selected.p3b2.recipe.device,
        inode: selected.p3b2.recipe.inode,
        size: selected.p3b2.recipe.size,
      }),
      process: observation,
    });
    assertControlCurrent();
    admittedPlans.set(admission, { plan: canonicalJson(selectedPlan), assertControlCurrent });
    return admission;
  } finally {
    const failures: unknown[] = [];
    for (const fd of roots.reverse()) {
      try {
        closeSync(fd);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'selected_supervisor_admission_close');
  }
}

/** Only the actual namespace verifier can produce this receipt. Its internal
 * selection is checked in full before every native Owner launch. */
export function assertSelectedPlanAdmission(
  admission: SelectedPlanAdmission,
  plan: SupervisorPlan
): void {
  const retained = admission && admittedPlans.get(admission);
  check(
    retained && retained.plan === canonicalJson(plan) && plan.supervisorSourceInvocation,
    'receipt'
  );
  assertSelectedSupervisorObservation(admission.process, plan.supervisorSourceInvocation);
  retained.assertControlCurrent();
}
