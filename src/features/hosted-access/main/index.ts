export type {
  CreateHostedAccessFeatureDependencies,
  HostedAccessEnvironment,
  HostedAccessFeature,
  HostedAuthHttpFacade,
  HostedAuthLocalControlHandle,
} from './composition/createHostedAccessFeature';
export {
  createHostedAccessFeature,
  HOSTED_PERSONAL_POLICY,
} from './composition/createHostedAccessFeature';
export type { HostedPairingMaterialState } from './composition/hostedPairingMaterial';
export {
  probeHostedPairingMaterial,
  resolveHostedPairingCodePath,
} from './composition/hostedPairingMaterial';
