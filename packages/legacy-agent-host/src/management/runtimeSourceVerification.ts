import { z } from 'zod';

/** Finite, redacted outcomes shared by source receipts and the private Main port. */
export const runtimeSourceRefusalSchema = z.enum([
  'unqualified-version',
  'generation-change-unqualified',
  'native-version-mismatch',
  'native-outcome-unknown',
  'cleanup-unconfirmed',
  'source-changed',
  'configuration-invalid',
  'configuration-changed',
]);
export type RuntimeSourceRefusal = z.infer<typeof runtimeSourceRefusalSchema>;

export interface RuntimeSourceNativeIdentity {
  nativeVersion: string;
  seedNativeVersion?: string;
}
export interface RuntimeSourceNativeCheck {
  run(): Promise<RuntimeSourceNativeIdentity>;
  close(): Promise<boolean>;
}
