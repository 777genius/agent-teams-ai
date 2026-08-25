export const repositoryRoot: string;
export const drainEvidenceEnvelopeId: string;
export const drainEvidenceEnvelopeSchemaPath: string;

export interface DrainEvidenceEnvelope {
  envelopeId: string;
  ready: Record<string, unknown>;
  drained: Record<string, unknown>;
}

export interface DrainEvidenceValidationResult {
  ok: boolean;
  violations: string[];
}

export interface DrainEvidenceEnvelopeSchema {
  $id: string;
  $defs: {
    ready: { required: string[] };
    drained: { required: string[] };
  };
  [field: string]: unknown;
}

export function loadDrainEvidenceEnvelopeSchema(root?: string): DrainEvidenceEnvelopeSchema;
export function drainEvidenceEnvelopeSchemaSha256(root?: string): string;
export function validateDrainEvidenceEnvelope(
  envelope: DrainEvidenceEnvelope,
  schema?: DrainEvidenceEnvelopeSchema
): DrainEvidenceValidationResult;
export function createDrainEvidenceEnvelope(
  ready: Record<string, unknown>,
  drained: Record<string, unknown>
): DrainEvidenceEnvelope;
export function assertDrainEvidenceEnvelope<T extends DrainEvidenceEnvelope>(envelope: T): T;
export function validateW4DrainEvidenceProjection(
  nativeProtocolSchema: unknown,
  processAnchorProtocol: unknown,
  root?: string
): DrainEvidenceValidationResult;
