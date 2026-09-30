export interface HostedLockVerificationOptions {
  ifPresent?: boolean;
  /** Test seam used to prove marker revalidation; not for production use. */
  onMarkerRead?: (marker: { marker: Record<string, unknown> }) => void | Promise<void>;
  /** Test seam used to prove generation-entry revalidation; not for production use. */
  onGenerationOpened?: (generation: { transactionName: string }) => void | Promise<void>;
  /** @deprecated Root-pair inspection is no longer part of authoritative verification. */
  onEntriesInspected?: () => void | Promise<void>;
  /** @deprecated Root-pair inspection is no longer part of authoritative verification. */
  onFileOpened?: (filename: string) => void | Promise<void>;
  /** @deprecated Root-pair inspection is no longer part of authoritative verification. */
  onFileRead?: (filename: string) => void | Promise<void>;
  /** @deprecated Root-pair inspection is no longer part of authoritative verification. */
  onFileClosed?: (filename: string) => void | Promise<void>;
}

export type HostedLockVerificationResult =
  | { status: 'absent' }
  | { status: 'verified' };

export function verifyHostedLocksAtRoot(
  root: string,
  options?: HostedLockVerificationOptions
): Promise<HostedLockVerificationResult>;
