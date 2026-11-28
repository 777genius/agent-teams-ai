import type { CodexDriverConfig } from '@agent-teams/provider-implementations/codex';
import type {
  RuntimeInputEvidenceBinding,
  bindRuntimeInputEvidence,
} from './bindRuntimeInputEvidence.js';
import type { ToolEvidenceWindows } from './ToolEvidenceWindows.js';
import type { WorkspaceSnapshot } from './captureContracts.js';
export type CodexCapturePort = NonNullable<CodexDriverConfig['capture']>;
export type CodexCaptureRequest = Parameters<CodexCapturePort['observe']>[0];
export type CodexAfterRequest = Extract<CodexCaptureRequest, { phase: 'after' }>;
export type CodexCaptureItem = CodexAfterRequest['items'][number];
export interface CodexEvidenceCaptureOptions extends Omit<
  Parameters<typeof bindRuntimeInputEvidence>[0],
  'request'
> {
  readonly ledgerProjectDir: string;
  readonly windows: ToolEvidenceWindows;
  withWriteFence<T>(action: () => T): T;
}
export interface CodexEvidenceCapture extends CodexCapturePort {
  seal(): void;
  readStatus(): Readonly<{
    phase: 'idle' | 'capturing' | 'gap' | 'sealed';
    baseline: 'pending' | 'ready' | 'missed';
    reason?: string;
  }>;
}
export interface CodexEvidenceWindow {
  readonly binding: RuntimeInputEvidenceBinding;
  readonly request: Extract<CodexCaptureRequest, { phase: 'before' }>;
  readonly warnings: Set<string>;
  before?: WorkspaceSnapshot;
  invalidReason?: string;
  settlement?: Promise<void>;
  terminalFingerprint?: string;
}
export interface CodexUpdatePatchProof {
  readonly kind: 'codex-update-patch-v1';
  readonly toolInputDigest: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly windowRef: string;
  readonly itemIds: readonly string[];
}
