import type { OpenCodeV1DriverConfig } from '@agent-teams/provider-implementations/opencode';
import type {
  RuntimeInputEvidenceBinding,
  bindRuntimeInputEvidence,
} from './bindRuntimeInputEvidence.js';
import type { ToolEvidenceWindows } from './ToolEvidenceWindows.js';
import type { WorkspaceSnapshot } from './captureContracts.js';
export type OpenCodeCapturePort = NonNullable<OpenCodeV1DriverConfig['capture']>;
export type OpenCodeCaptureRequest = Parameters<OpenCodeCapturePort['observe']>[0];
export type OpenCodeAfterRequest = Extract<OpenCodeCaptureRequest, { phase: 'after' }>;
export type OpenCodeCaptureItem = OpenCodeAfterRequest['items'][number];
export interface OpenCodeEvidenceCaptureOptions extends Omit<
  Parameters<typeof bindRuntimeInputEvidence>[0],
  'request'
> {
  readonly ledgerProjectDir: string;
  readonly windows: ToolEvidenceWindows;
  withWriteFence<T>(action: () => T): T;
}
export interface OpenCodeEvidenceCapture extends OpenCodeCapturePort {
  seal(): void;
  readStatus(): Readonly<{
    phase: 'idle' | 'capturing' | 'gap' | 'sealed';
    baseline: 'pending' | 'ready' | 'missed';
    reason?: string;
  }>;
}
export interface OpenCodeEvidenceWindow {
  readonly binding: RuntimeInputEvidenceBinding;
  readonly request: Extract<OpenCodeCaptureRequest, { phase: 'before' }>;
  readonly warnings: Set<string>;
  before?: WorkspaceSnapshot;
  invalidReason?: string;
  settlement?: Promise<void>;
  terminalFingerprint?: string;
}
export interface OpenCodeToolAnchor {
  readonly messageId: string;
  readonly partId: string;
  readonly callId: string;
}
export interface OpenCodeUpdatePatchProof {
  readonly kind: 'opencode-update-patch-v1';
  readonly toolInputDigest: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly nativeSessionId: string;
  readonly nativeInputId: string;
  readonly windowRef: string;
  /** Order is a unique exact-byte patch chain, not an execution sequence. */
  readonly tools: readonly OpenCodeToolAnchor[];
}
