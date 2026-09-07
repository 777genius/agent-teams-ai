import { canonicalJson, RUNTIME_CAPTURE_NAMES } from './contracts';

import type { NativeCaptureShard } from './native-captures';
import type { P1HttpCorrelationResult } from './native-http-join';
import type { SupervisorOutcome, SupervisorPlan } from './processes';

export const P2_SCENARIO_REQUIREMENTS = Object.freeze([
  'owner-wal-disk-custody-and-verified-native-corpus',
  'native-scenario-derivation-without-legacy-effect-total-rows',
]);

// These are concrete composition obligations, not selectable flags. There is deliberately no
// admitted constructor: the current driver has no retained inputs that can discharge them.
export const P1_ADMISSION_REQUIREMENTS = Object.freeze([
  'selected-supervisor-launch-observations-and-stack-manifest',
  'bootstrap-v2-header-statement-and-descriptor-map-bound-to-held-sealed-executed-owner',
  'opencode-coordinator-readiness-bound-to-retained-child-and-selected-profile',
  'verified-ed25519-activation-publication-and-signed-routes-bound-to-owner-start',
  'fd8-prefix-capture-and-recorder-binding-with-owner-producer-capsule',
  'all-native-family-producer-capture-and-activation-bindings-to-selected-stack',
]);

export class P1AdmissionUnverified extends Error {
  readonly admission = 'unverified' as const;
  readonly missing = P1_ADMISSION_REQUIREMENTS;
  readonly nextGate = Object.freeze({
    reason: 'p3c_runtime_capture_semantic_mapping_unavailable:ownerWalTimelinePath',
    missing: P2_SCENARIO_REQUIREMENTS,
  });

  constructor(readonly correlation: P1HttpCorrelationResult | null = null) {
    super('p3c_p1_admission_unverified');
    this.name = 'P1AdmissionUnverified';
  }
}

const PRODUCER_ROLES = ['owner', 'opencode', 'product', 'browser'] as const;
type ProducerRole = (typeof PRODUCER_ROLES)[number];
type ImagePin = Readonly<{ device: string; inode: string; sha256: string }>;
type ProducerPin = ImagePin & Readonly<{
  artifactManifestSha256: string;
  moduleSha256: string;
}>;

/** Only the selection already made by preflight. It is NOT a bootstrap/activation admission. */
export interface P1LaunchSelection {
  readonly controllerNonce: string;
  readonly runId: string;
  readonly supervisor: ImagePin;
  readonly producers: Readonly<Record<ProducerRole, ProducerPin>>;
}

/** Called by the real driver with its admitted plan, before any supervisor observations arrive. */
export function snapshotP1LaunchSelection(plan: SupervisorPlan): P1LaunchSelection {
  const image = (role: ProducerRole | 'supervisor'): ImagePin => Object.freeze({
    device: plan.expectedExecutableDevice[role],
    inode: plan.expectedExecutableInode[role],
    sha256: plan.expectedExecutableSha256[role],
  });
  const producer = (role: ProducerRole) => Object.freeze({
    ...image(role),
    artifactManifestSha256: plan.expectedProducerArtifactSha256[role],
    moduleSha256: plan.expectedProducerModuleSha256[role],
  });
  return Object.freeze({
    controllerNonce: plan.controllerNonce,
    runId: plan.runId,
    supervisor: image('supervisor'),
    producers: Object.freeze({
      owner: producer('owner'),
      opencode: producer('opencode'),
      product: producer('product'),
      browser: producer('browser'),
    }),
  });
}

/** Check every family, including non-OpenCode roles. Agreement is still only correlation until
 * the selected stack, launch, readiness and signed publication observations are composed. */
export function assertP1NativeBindings(
  shards: readonly NativeCaptureShard[],
  outcome: SupervisorOutcome,
  selection?: P1LaunchSelection
): void {
  for (const name of RUNTIME_CAPTURE_NAMES) {
    if (!shards.some((shard) => shard.name === name))
      throw new Error(`p3c_p1_native_family_missing:${name}`);
  }
  const activation = shards[0]?.parsed.records[0]?.activation;
  if (!activation) throw new Error('p3c_p1_native_activation_missing');
  if (selection) {
    const supervisor = outcome.supervisorStart;
    if (
      selection.controllerNonce !== outcome.controllerNonce ||
      selection.runId !== outcome.runId ||
      supervisor.role !== 'supervisor' ||
      supervisor.executableDevice !== selection.supervisor.device ||
      supervisor.executableInode !== selection.supervisor.inode ||
      supervisor.executableSha256 !== selection.supervisor.sha256
    )
      throw new Error('p3c_p1_selected_supervisor_disagreement');
  }
  for (const shard of shards) {
    for (const record of shard.parsed.records) {
      if (
        canonicalJson(record.activation) !== canonicalJson(activation) ||
        record.activation.controllerNonce !== outcome.controllerNonce ||
        record.activation.runId !== outcome.runId
      )
        throw new Error(`p3c_p1_native_stack_disagreement:${shard.name}`);
      if (!selection) continue;
      const role =
        record.producer.role === 'product-producer' ? 'product' : record.producer.role;
      if (!PRODUCER_ROLES.includes(role as ProducerRole))
        throw new Error(`p3c_p1_selected_producer_role:${shard.name}`);
      const pin = selection.producers[role as ProducerRole];
      if (
        record.producer.exeDev !== pin.device ||
        record.producer.exeIno !== pin.inode ||
        record.producer.exeSha256 !== pin.sha256 ||
        record.producer.artifactManifestSha256 !== pin.artifactManifestSha256 ||
        record.producer.moduleSha256 !== pin.moduleSha256
      )
        throw new Error(`p3c_p1_selected_producer_disagreement:${shard.name}`);
    }
  }
}
