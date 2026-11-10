import type {
  ClaudeCapturePort,
  ClaudeCaptureRequest,
} from '@agent-teams/provider-implementations/claude';
import type { bindTaskToolEvidence, TaskToolEvidenceBinding } from './bindTaskToolEvidence.js';
import type { ToolEvidenceWindows } from './ToolEvidenceWindows.js';

export type EvidenceBindingOptions = Omit<Parameters<typeof bindTaskToolEvidence>[0], 'request'>;
export interface EvidenceCaptureOptions extends EvidenceBindingOptions {
  /** Host-owned Team namespace, separate from the native workspace. */
  readonly ledgerProjectDir: string;
  readonly windows: ToolEvidenceWindows;
  /** Synchronous generation/storage fence. Never await while holding it. */
  withWriteFence<T>(action: () => T): T;
}
export interface ToolEvidenceCapture extends ClaudeCapturePort {
  seal(): void;
  readStatus(): Readonly<{ phase: 'idle' | 'capturing' | 'gap' | 'sealed'; reason?: string }>;
}
export interface ClaudeNativeFileEffectProof {
  readonly kind: 'edit-input-v1' | 'write-input-v1';
  readonly toolInputDigest: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
}
export type NativeFileEffectProof =
  | ClaudeNativeFileEffectProof
  | import('./codexCaptureContracts.js').CodexUpdatePatchProof
  | import('./opencodeCaptureContracts.js').OpenCodeUpdatePatchProof;
export interface FileImage {
  readonly exists?: boolean;
  readonly content?: Buffer;
  readonly sha256?: string;
  readonly reason?: string;
}
export interface WorkspaceSnapshot {
  readonly files: ReadonlyMap<string, FileImage>;
  readonly warnings: readonly string[];
  /** All selected Git/direct/prior paths were read without truncation; never global coverage or absence proof. */
  readonly complete: boolean;
}
export interface EvidenceWindow {
  readonly binding: TaskToolEvidenceBinding;
  readonly request: Extract<ClaudeCaptureRequest, { phase: 'before' }>;
  readonly fingerprint: string;
  before?: WorkspaceSnapshot;
  outcome?: 'succeeded' | 'failed';
  invalidReason?: string;
  settlement?: Promise<void>;
  /** Original private observation lease, not authority to submit more native work. */
  background?: Readonly<{ taskRef: string; runRef?: string; signal: AbortSignal }>;
  readonly warnings: Set<string>;
}
export const NATIVE_INTERVAL_WARNING =
  'Native capture interval is partial: project hook ordering, background completion and external writer exclusivity are not qualified.';
