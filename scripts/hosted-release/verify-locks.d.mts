export interface VerifyHostedLocksOptions {
  ifPresent?: boolean;
  onFileOpened?: (filename: string) => void | Promise<void>;
}

export type VerifyHostedLocksResult = { status: 'absent' | 'verified' };

export function verifyHostedLocksAtRoot(
  root: string,
  options?: VerifyHostedLocksOptions
): Promise<VerifyHostedLocksResult>;
