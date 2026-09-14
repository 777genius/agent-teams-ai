import { canonicalJson, sha256 } from './supervisor/canonical';
import { legacyOwnerChildPlan, ownerChildPlanV2, OWNER_V2_ARGV } from './owner-child-protocol';
import type { PreflightAdmission } from './preflight';
import type { SupervisorPlan } from './processes';

function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`p3c_owner_plan_${reason}`);
}
export function selectOwnerPlan(admission: PreflightAdmission) {
  const launch = admission.ownerLaunch;
  if (!launch)
    return {
      protocol: legacyOwnerChildPlan(),
      image: admission.execution.ownerEntry.pin,
      argv: legacyOwnerChildPlan().wrapperArgv,
      selection: {},
    };
  const { selection: s } = launch;
  check(
    s.protocolVersion === 2 &&
      s.recipeSha256 === admission.descriptor.p3b2.recipeSha256 &&
      s.recipeSha256 === admission.descriptor.p3b2.recipe.sha256 &&
      canonicalJson(launch.executable.pin) === canonicalJson(s.executable) &&
      canonicalJson(launch.helper.pin) === canonicalJson(s.helper),
    'admitted_images'
  );
  check(
    canonicalJson(admission.execution.ownerEntry.pin) ===
      canonicalJson(admission.descriptor.p3b2.entry) &&
      (s.compiled
        ? !s.source &&
          canonicalJson(s.executable) === canonicalJson(admission.descriptor.p3b2.entry) &&
          s.compiled.module.path === '/p3b2/bin/hosted-owner' &&
          s.compiled.module.sha256 === s.executable.sha256
        : s.source &&
          s.source.module.path === `/p3b2/${admission.descriptor.p3b2.entry.relativePath}` &&
          s.source.module.sha256 === admission.descriptor.p3b2.entry.sha256 &&
          s.source.executable.device === s.executable.device &&
          s.source.executable.inode === s.executable.inode &&
          s.source.executable.sha256 === s.executable.sha256),
    'admitted_module'
  );
  const contract = admission.closures.harness.entries.find(
    (e) => e.path === 'scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json'
  );
  check(contract && /^[0-9a-f]{64}$/u.test(contract.sha256), 'harness_contract');
  return {
    protocol: ownerChildPlanV2(!!s.preparationModule),
    image: s.executable,
    argv: Object.freeze(
      s.compiled ? [...OWNER_V2_ARGV] : ['run', s.source!.module.path, ...OWNER_V2_ARGV]
    ),
    selection: {
      ...(s.source ? { ownerSourceInvocation: s.source } : {}),
      ownerLaunchHelper: s.helper,
      ownerRecipeSha256: s.recipeSha256,
      ownerHarnessContractSha256: contract.sha256,
      ...(s.preparationModule ? { ownerPreparationModule: s.preparationModule } : {}),
      ...(s.kernelModule ? { selectedKernelModule: s.kernelModule } : {}),
    },
  };
}
/** Checks redundant plan/manifest values at both the selected caller and transcript boundary. */
export function assertOwnerPlanV2(plan: SupervisorPlan): void {
  check(
    canonicalJson(plan.ownerChildProtocol) ===
      canonicalJson(ownerChildPlanV2(!!plan.ownerPreparationModule)),
    'protocol_v2'
  );
  const supervisor = plan.supervisorSourceInvocation;
  if (supervisor) {
    check(
      supervisor.format === 'agent-teams.hosted-selected-supervisor-invocation/v1' &&
        supervisor.executable.root === 'toolchain' &&
        supervisor.loader.root === 'toolchain' &&
        supervisor.module.root === 'p3b2' &&
        supervisor.launcher.root === 'p3b2' &&
        supervisor.executable.device === plan.expectedExecutableDevice.supervisor &&
        supervisor.executable.inode === plan.expectedExecutableInode.supervisor &&
        supervisor.executable.sha256 === plan.expectedExecutableSha256.supervisor &&
        canonicalJson(plan.expectedArgv.supervisor) ===
          canonicalJson([
            '--import',
            `/toolchain/${supervisor.loader.relativePath}`,
            `/p3b2/${supervisor.module.relativePath}`,
            '--selected-supervisor-v1',
          ]),
      'selected_supervisor'
    );
  }
  const s = plan.ownerSourceInvocation,
    helper = plan.ownerLaunchHelper;
  check(
    helper &&
      helper.root === 'p3b2' &&
      helper.mode === 0o500 &&
      helper.nlink === 1 &&
      /^[0-9a-f]{64}$/u.test(helper.sha256) &&
      /^[0-9a-f]{64}$/u.test(plan.ownerRecipeSha256 ?? '') &&
      /^[0-9a-f]{64}$/u.test(plan.ownerHarnessContractSha256 ?? ''),
    'selected_helper_recipe'
  );
  const manifest = plan.runtimeManifest;
  check(
    manifest.runId === plan.runId &&
      manifest.refs.openCodeExecutableSha256 === plan.expectedExecutableSha256.opencode &&
      manifest.schemaVersion === 1 &&
      manifest.purpose === 'agent-teams.hosted-actual-owner-e2e/v1',
    'manifest'
  );
  if (s) {
    check(
      s.format === 'agent-teams.hosted-owner-source-invocation/v1' &&
        s.executable.device === plan.expectedExecutableDevice.owner &&
        s.executable.inode === plan.expectedExecutableInode.owner &&
        s.executable.sha256 === plan.expectedExecutableSha256.owner &&
        s.module.sha256 === plan.expectedProducerModuleSha256.owner &&
        typeof s.module.path === 'string' &&
        s.module.path.startsWith('/p3b2/') &&
        !s.module.path.includes('\\') &&
        s.module.path
          .split('/')
          .slice(1)
          .every((p) => p && p !== '.' && p !== '..') &&
        Buffer.byteLength(s.module.path) <= 4096 &&
        !s.module.path.includes('\0') &&
        canonicalJson(plan.expectedArgv.owner) ===
          canonicalJson(['run', s.module.path, ...OWNER_V2_ARGV]),
      'source_selection'
    );
  } else {
    check(
      plan.expectedExecutableSha256.owner === plan.expectedProducerModuleSha256.owner &&
        canonicalJson(plan.expectedArgv.owner) === canonicalJson(OWNER_V2_ARGV),
      'built_selection'
    );
  }
}
/** Observation retained internally by executeSupervisor; the pure predicate below grants no authority. */
export interface SupervisorTranscriptReceipt {
  readonly pid: number;
  readonly startTime: string;
  readonly transcriptSha256: string;
}
export function assertSelectedSupervisorTranscript(
  bytes: Uint8Array,
  plan: SupervisorPlan,
  supervisor: { pid: number; startTime: string },
  receipt?: SupervisorTranscriptReceipt
): void {
  assertOwnerPlanV2(plan);
  check(
    receipt &&
      receipt.pid === supervisor.pid &&
      receipt.startTime === supervisor.startTime &&
      receipt.transcriptSha256 === sha256(bytes),
    'selected_transcript_receipt'
  );
}
