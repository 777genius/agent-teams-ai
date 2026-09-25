import type { HostedAuthMode } from '@features/hosted-access';
import type { HostedPairingMaterialState } from '@features/hosted-access/main';

/** Lifecycle actions that may start or resume a host-local agent runtime. */
export const HOSTED_RUNTIME_CREATING_LIFECYCLE_ACTIONS = Object.freeze([
  'launch',
  'recover',
] as const);
const RUNTIME_CREATING_ACTIONS: ReadonlySet<string> = new Set(
  HOSTED_RUNTIME_CREATING_LIFECYCLE_ACTIONS
);

export type HostedRuntimeCreationRefusalCode =
  | 'host_local_runtime_requires_personal_mode'
  | 'pairing_material_materialized'
  | 'pairing_material_unverifiable';

const REFUSAL_DETAILS: Readonly<Record<HostedRuntimeCreationRefusalCode, string>> = Object.freeze({
  host_local_runtime_requires_personal_mode:
    'host-local agent runtime is limited to personal single-operator mode',
  pairing_material_materialized:
    'a plaintext pairing file is materialized; complete pairing before starting agents',
  pairing_material_unverifiable:
    'the pairing file path cannot be observed; agents stay stopped until it can',
});

export interface HostedRuntimeCreationAdmission {
  /** Resolves false when the action must not reach the lifecycle owner. */
  readonly admit: (action: string) => Promise<boolean>;
}

export interface CreateHostedRuntimeCreationAdmissionDependencies {
  readonly authMode: HostedAuthMode;
  readonly pairingMaterial: () => Promise<HostedPairingMaterialState>;
  readonly reportRefusal: (diagnostic: string) => void;
}

export function formatHostedRuntimeCreationRefusal(code: HostedRuntimeCreationRefusalCode): string {
  return `Hosted readiness diagnostic stage=runtime_creation outcome=refused code=${code} detail=${REFUSAL_DETAILS[code]}`;
}

/**
 * ADR-30 trusted_process gate for runtime-creating lifecycle actions. Agents share the deployment
 * OS user, so they are admitted only for the personal single operator and never while plaintext
 * pairing material exists that a same-UID agent could read. Stop and cancel are never gated.
 */
export function createHostedRuntimeCreationAdmission(
  dependencies: CreateHostedRuntimeCreationAdmissionDependencies
): HostedRuntimeCreationAdmission {
  const refuse = (code: HostedRuntimeCreationRefusalCode): false => {
    dependencies.reportRefusal(formatHostedRuntimeCreationRefusal(code));
    return false;
  };
  // Announce the deployment-wide refusal at startup, before any operator tries to launch.
  if (dependencies.authMode !== 'personal') refuse('host_local_runtime_requires_personal_mode');
  return Object.freeze({
    admit: async (action: string): Promise<boolean> => {
      if (!RUNTIME_CREATING_ACTIONS.has(action)) return true;
      if (dependencies.authMode !== 'personal') {
        return refuse('host_local_runtime_requires_personal_mode');
      }
      let material: HostedPairingMaterialState;
      try {
        material = await dependencies.pairingMaterial();
      } catch {
        material = 'unavailable';
      }
      if (material === 'absent') return true;
      return refuse(
        material === 'present' ? 'pairing_material_materialized' : 'pairing_material_unverifiable'
      );
    },
  });
}
