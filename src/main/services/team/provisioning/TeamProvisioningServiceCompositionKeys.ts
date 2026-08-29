import type { TeamProvisioningServiceComposition } from './TeamProvisioningServiceComposition';
import type {
  DuplicateCompositionKey,
  MissingCompositionKey,
} from './TeamProvisioningServiceCompositionKeyTypes';

export const TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS = [
  'configFacade',
  'liveRuntimeMetadataPorts',
  'runtimeSnapshotFacade',
  'openCodeRuntimeDeliveryBoundaryHost',
  'launchStateStoreBoundary',
  'persistenceReconcileFacade',
  'launchStateCompatibilityBoundary',
  'configTaskActivityBoundary',
  'toolApprovalFacade',
  'idlePromptInjectionBoundary',
  'providerRuntime',
  'providerRuntimeCompatibility',
  'openCodeRuntimeRecoveryFacade',
  'openCodePromptDeliveryWatchdogScheduler',
  'compatibilityDelegation',
  'outputRecoveryFacade',
  'deterministicLaunchFlowBoundary',
  'deterministicCreateSpawnFlowBoundary',
  'verificationProbePorts',
  'processExitPorts',
  'prepareFacade',
  'memberMcpLaunchConfigProvisioner',
  'openCodeVisibleReplyProofService',
  'openCodePromptDeliveryWatchdogCoordinator',
  'bootstrapTranscriptFacade',
  'bootstrapEvidenceFacade',
  'leadInboxRelayFacade',
  'cleanupRunPorts',
  'transientRunState',
  'requestAdmissionBoundary',
  'openCodeRuntimeControlApi',
  'memberLifecycleController',
  'memberLifecycleFacade',
] as const satisfies readonly (keyof TeamProvisioningServiceComposition)[];

export const TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_EXHAUSTIVE: [
  MissingCompositionKey<
    TeamProvisioningServiceComposition,
    typeof TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS
  >,
] extends [never]
  ? true
  : false = true;

export const TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_UNIQUE: [
  DuplicateCompositionKey<typeof TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS>,
] extends [never]
  ? true
  : false = true;
