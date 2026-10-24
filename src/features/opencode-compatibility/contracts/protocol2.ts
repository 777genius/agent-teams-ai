import type {
  EndpointAuthority,
  Generation,
  NativeIdentity,
  NativeKey,
  SessionAuthority,
  SupportState,
} from './types';

export type Operation =
  | 'generationIdentity'
  | 'bootstrap'
  | 'deliveryAcceptance'
  | 'interaction'
  | 'permissionAnswer'
  | 'transcriptNormalization'
  | 'fileParts'
  | 'taskLedgerEvidence'
  | 'expectedBehaviorFingerprint';
export type OperationMap = Readonly<
  Partial<
    Record<
      Operation,
      {
        version: number;
        fingerprint: string;
        availability: 'qualified' | 'pending' | 'absent';
        qualificationDigest: string | null;
      }
    >
  >
>;
export interface Protocol2Offer {
  schemaVersion: 1;
  minVersion: 1;
  currentVersion: 2;
  selected: NativeIdentity;
  requiredOperations: Partial<Record<Operation, number>>;
}
export interface Protocol2Handshake {
  schemaVersion: 1;
  protocolVersion: 2;
  supportedGenerations: readonly Generation[];
  dialects: Partial<Record<NativeKey['apiDialect'], OperationMap>>;
  selectedNative: NativeIdentity | null;
  selectionEpoch: string | null;
  selectedAuthority: EndpointAuthority | null;
  support: SupportState;
  qualificationDigest: string | null;
}
export interface Protocol2CommandContext {
  schemaVersion: 1;
  protocolVersion: 2;
  operation: Operation;
  operationVersion: number;
  operationFingerprint: string;
  native: NativeIdentity;
  selectionEpoch: string;
  authority: SessionAuthority;
  operationId: string;
  expectedObservationEpoch: string;
  expectedCapabilitySnapshotId: string;
  expectedManifestHighWatermark: number;
  expectedRunId: string;
  handshakeIdentityHash: string;
}
