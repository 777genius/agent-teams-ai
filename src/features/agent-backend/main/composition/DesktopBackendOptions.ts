import type { BackendRoutingError, HandleBindingStore } from '../application/backendBinding';
import type { TeamModelProbeIntents } from '../application/TeamModelProbeIntents';
import type { NativePromptSettingsSelection } from '../infrastructure/CapturedNativePromptOptions';
import type { DesktopBackendDescriptorSelection } from '../infrastructure/loadDesktopBackendDescriptor';
import type { ApplicationCommandRunner } from '@features/application-command-ledger';
import type { NativeNextPromptCandidate } from '@features/native-prompt-suggestions/contracts';

export type InitializationPhase =
  | 'descriptor'
  | 'owner-registration'
  | 'handle-read'
  | 'handle-publication'
  | 'default-owner';

export interface DesktopBackendFeatureOptions extends NativePromptSettingsSelection {
  /** Null is the safe default: no descriptor, handles or process launch. */
  descriptor: DesktopBackendDescriptorSelection | null;
  bindingDirectory: string;
  /** Trusted app-global preference source; never supplied by a renderer command. */
  reviewFlowDefaultsDirectory?: string;
  /** Private composition diagnostics; never serializes paths, payloads or raw errors. */
  onInitializationFailure?: (
    phase: InitializationPhase,
    code: BackendRoutingError['code'] | 'unexpected'
  ) => void;
  /** Existing durable storage port, useful for composing the app's chosen persistence. */
  bindings?: HandleBindingStore;
  /** Existing durable Main ledger is supplied before renderer work admission. */
  commandRunner?: () => ApplicationCommandRunner | null;
  modelIntents?: TeamModelProbeIntents;
  /** Ephemeral validated Host output; Main owns IPC/HTTP publication. */
  onNativePromptSuggestion?: (value: NativeNextPromptCandidate) => void;
}
