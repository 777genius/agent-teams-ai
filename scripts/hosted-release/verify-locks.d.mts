export interface HostedLockVerificationOptions {
  ifPresent?: boolean;
  onEntriesInspected?: () => void | Promise<void>;
  onFileOpened?: (filename: string) => void | Promise<void>;
  onFileRead?: (filename: string) => void | Promise<void>;
  onFileClosed?: (filename: string) => void | Promise<void>;
}

export type HostedLockVerificationResult =
  | { status: 'absent' }
  | { status: 'verified' };

export function verifyHostedLocksAtRoot(
  root: string,
  options?: HostedLockVerificationOptions
): Promise<HostedLockVerificationResult>;
