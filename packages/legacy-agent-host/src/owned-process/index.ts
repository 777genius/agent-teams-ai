/** Shared private Windows launch primitive; never a renderer process-control API. */
export * from './contract.js';
export * from './codec.js';
export { BrokerReleaseConfirmation } from './releaseConfirmation.js';
export {
  connectPrivateBroker,
  createWindowsOwnedLaunchPort,
  verifyStagedBroker,
} from './windowsBroker.js';
export type { BrokerTransport, BrokerTransportFactory } from './windowsBroker.js';
export { OwnedProcessFacade } from './processFacade.js';
export type { ObservableNativeProcess, OwnedProcessFacadeOptions } from './processFacade.js';
export * from './hostCustody.js';
export { RetainedWindowsCustody } from './RetainedWindowsCustody.js';
export { windowsBrokerReference } from './HostWindowsLaunch.js';
export { readCapturedProfile } from './readCapturedProfile.js';
export { nativeProcessProfileSchema } from '../composition/nativeProcessProfile.js';
export type { NativeProcessProfile } from '../composition/nativeProcessProfile.js';
export {
  buildWindowsShellFallbackCommand,
  isWindowsBatchLauncher,
  quoteWindowsCmdArg,
  resolveDirectWindowsLauncher,
} from './windowsCliLauncher.js';
export { captureWindowsLauncher, matchesCapturedWindowsLauncher } from './capturedWindowsLauncher.js';
export type { CapturedWindowsLauncher } from './capturedWindowsLauncher.js';
export { runtimeSourceVersionProfile } from '../adapters/providers/runtimeSourceVersionProfile.js';
export { windowsLaunchSpec } from '../adapters/providers/WindowsCapturedProcess.js';
export { runtimeSourceProcessContextSchema, readRetainedRuntimeSourceSelections,
  readPreparedRuntimeSourcePublication, readRuntimeSourceConfigurationVersion } from './runtimeSourceSelections.js';
export type { RuntimeSourceProcessContext, RetainedRuntimeSourceSelection } from './runtimeSourceSelections.js';
export { selectRuntimeSourceSeed, sameRuntimeSourceGrantAuthority,
  assertRuntimeSourceScopeAvailable } from '../composition/runtimeSourceGrantAuthority.js';
export { assertRuntimeSourceQualification } from '../composition/verifyRuntimeSourceCandidate.js';
export { runtimeSourceProcessOriginSchema, runtimeSourceRecipeIdentity } from '../composition/runtimeSourceProcessOrigin.js';
export type { RuntimeSourceProcessOrigin } from '../composition/runtimeSourceProcessOrigin.js';
export { runtimeMemberProfileSchema } from '../composition/runtimeProfile.js';
export { resolveRuntimeRecipe } from '../composition/runtimeRecipe.js';
