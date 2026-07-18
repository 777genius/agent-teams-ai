export type OpenCodeExecutionProofCredentialMode = 'api' | 'oauth' | 'none' | 'unknown';

export interface OpenCodeExecutionProof {
  schemaVersion: 1;
  providerId: 'opencode';
  modelId: string;
  projectPath: string;
  profileRootKey: string;
  projectBehaviorFingerprint: string;
  managedConfigFingerprint: string;
  managedAuthFingerprint: string | null;
  binaryPath: string;
  binaryFingerprint: string;
  opencodeVersion: string | null;
  capabilitySnapshotId: string | null;
  credentialMode: OpenCodeExecutionProofCredentialMode;
  reusable: boolean;
  verifiedAt: string;
  expiresAt: string;
  proofHash: string;
}
