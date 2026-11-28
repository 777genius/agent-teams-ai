import type { CapturedHostClient } from './CapturedHostClient';
import type { NativePromptSettingsSelection } from './CapturedNativePromptOptions';
import type { HostClientError } from './selectedHostProfile';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type {
  HostCustodyCall,
  HostCustodyHint,
  HostCustodyReply,
} from '@agent-teams/legacy-agent-host/owned-process';

export interface NativeRequest {
  call: HostCustodyCall;
  deadline: number;
  reserved: boolean;
  timer?: ReturnType<typeof setTimeout>;
  reply?: HostCustodyReply;
  admittedHint?: { hint: HostCustodyHint; sent: boolean };
}

export interface PendingRequest {
  maxFrameBytes: number;
  resolve: (value: JsonValue) => void;
  reject: (error: HostClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CapturedHostClientOptions extends NativePromptSettingsSelection {
  readonly reviewFlowDefaultsDirectory?: string;
  readonly onNativePromptSuggestion?: (value: unknown, source: CapturedHostClient) => void;
}

export interface CapturedHostShutdown {
  /** Only this captured child is observed; provider custody is never inferred. */
  childExit: 'confirmed' | 'unknown';
  providerCustody: 'unresolved';
}
