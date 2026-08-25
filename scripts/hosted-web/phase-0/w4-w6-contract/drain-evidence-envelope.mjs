import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, '../../../..');
export const drainEvidenceEnvelopeId = 'P0.CONTROLLER.W4_W6.DRAIN_EVIDENCE_ENVELOPE.V1';
export const drainEvidenceEnvelopeSchemaPath =
  'docs/research/hosted-web/phase-0/w4-w6-contract/drain-evidence-envelope.schema.json';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.hasOwn(value, key);

export function loadDrainEvidenceEnvelopeSchema(root = repositoryRoot) {
  return JSON.parse(readFileSync(resolve(root, drainEvidenceEnvelopeSchemaPath), 'utf8'));
}

export function drainEvidenceEnvelopeSchemaSha256(root = repositoryRoot) {
  return sha256(readFileSync(resolve(root, drainEvidenceEnvelopeSchemaPath)));
}

function validateExactObject(value, rule, label, violations) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    violations.push(`type:${label}:object`);
    return;
  }
  const required = rule.required ?? [];
  for (const field of required) {
    if (!own(value, field)) violations.push(`missing_field:${label}:${field}`);
  }
  if (rule.additionalProperties === false) {
    for (const field of Object.keys(value)) {
      if (!own(rule.properties ?? {}, field)) violations.push(`extra_field:${label}:${field}`);
    }
  }
  for (const [field, fieldRule] of Object.entries(rule.properties ?? {})) {
    if (!own(value, field)) continue;
    const actual = value[field];
    if (own(fieldRule, 'const') && actual !== fieldRule.const) {
      violations.push(`const:${label}:${field}`);
      continue;
    }
    if (fieldRule.type === 'string' && typeof actual !== 'string') {
      violations.push(`type:${label}:${field}:string`);
    } else if (
      fieldRule.type === 'string' &&
      fieldRule.minLength &&
      actual.length < fieldRule.minLength
    ) {
      violations.push(`min_length:${label}:${field}`);
    }
    if (fieldRule.type === 'integer' && !Number.isInteger(actual)) {
      violations.push(`type:${label}:${field}:integer`);
    } else if (fieldRule.type === 'integer' && actual < (fieldRule.minimum ?? -Infinity)) {
      violations.push(`minimum:${label}:${field}`);
    }
    if (fieldRule.type === 'array' && !Array.isArray(actual)) {
      violations.push(`type:${label}:${field}:array`);
    } else if (fieldRule.type === 'array' && actual.length > (fieldRule.maxItems ?? Infinity)) {
      violations.push(`max_items:${label}:${field}`);
    }
  }
}

export function validateDrainEvidenceEnvelope(
  envelope,
  schema = loadDrainEvidenceEnvelopeSchema()
) {
  const violations = [];
  validateExactObject(envelope, schema, 'envelope', violations);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, violations };
  }
  if (envelope.envelopeId !== schema.$id || schema.$id !== drainEvidenceEnvelopeId) {
    violations.push('envelope_id');
  }
  validateExactObject(envelope.ready, schema.$defs.ready, 'ready', violations);
  validateExactObject(envelope.drained, schema.$defs.drained, 'drained', violations);

  const ready = envelope.ready;
  const drained = envelope.drained;
  if (ready && drained && typeof ready === 'object' && typeof drained === 'object') {
    for (const field of [
      'protocolVersion',
      'purpose',
      'resetGeneration',
      'deploymentGeneration',
      'processAnchorGeneration',
    ]) {
      if (ready[field] !== drained[field]) violations.push(`generation_binding:${field}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

export function createDrainEvidenceEnvelope(ready, drained) {
  const envelope = { envelopeId: drainEvidenceEnvelopeId, ready, drained };
  return assertDrainEvidenceEnvelope(envelope);
}

export function assertDrainEvidenceEnvelope(envelope) {
  const result = validateDrainEvidenceEnvelope(envelope);
  if (!result.ok) {
    throw new Error(`invalid controller drain-evidence envelope: ${result.violations.join(',')}`);
  }
  return envelope;
}

export function validateW4DrainEvidenceProjection(
  nativeProtocolSchema,
  processAnchorProtocol,
  root = repositoryRoot
) {
  const violations = [];
  const controllerSchema = loadDrainEvidenceEnvelopeSchema(root);
  const reference = nativeProtocolSchema?.['x-processAnchorDrainEvidence'];
  const expectedReference = {
    authority: 'phase-00-controller',
    envelopeId: drainEvidenceEnvelopeId,
    schemaPath: drainEvidenceEnvelopeSchemaPath,
    schemaSha256: drainEvidenceEnvelopeSchemaSha256(root),
    readyResponseType: 'ready',
    drainedResponseType: 'drained',
    projection: 'exact_required_fields_no_lane_owned_wrapper',
  };
  for (const [field, expected] of Object.entries(expectedReference)) {
    if (reference?.[field] !== expected) violations.push(`controller_reference:${field}`);
  }
  for (const field of Object.keys(reference ?? {})) {
    if (!own(expectedReference, field))
      violations.push(`controller_reference:extra_field:${field}`);
  }
  if (processAnchorProtocol?.artifactId !== 'agent-teams-process-anchor') {
    violations.push('w4_projection:artifact_id');
  }
  if (processAnchorProtocol?.$schema !== './native-protocol.schema.json') {
    violations.push('w4_projection:native_schema_reference');
  }

  const responseByType = new Map(
    (processAnchorProtocol?.responses ?? []).map((response) => [response.type, response])
  );
  for (const [type, definition] of [
    ['ready', controllerSchema.$defs.ready],
    ['drained', controllerSchema.$defs.drained],
  ]) {
    const actualFields = responseByType.get(type)?.fields;
    if (JSON.stringify(actualFields) !== JSON.stringify(definition.required)) {
      violations.push(`w4_projection:${type}_fields`);
    }
  }
  const expectedUnclassifiedFields = [
    ...controllerSchema.$defs.drained.required,
    'reason',
    'containerReplacementRequired',
  ];
  if (
    JSON.stringify(responseByType.get('unclassified_residual')?.fields) !==
    JSON.stringify(expectedUnclassifiedFields)
  ) {
    violations.push('w4_projection:unclassified_fields');
  }
  if (
    processAnchorProtocol?.sharedDrainDto?.kind !==
    controllerSchema.$defs.drained.properties.kind.const
  ) {
    violations.push('w4_projection:drain_kind');
  }
  if (
    own(processAnchorProtocol?.sharedDrainDto ?? {}, 'owner') ||
    own(processAnchorProtocol?.sharedDrainDto ?? {}, 'authority')
  ) {
    violations.push('w4_projection:w6_owned_authority_wrapper');
  }
  return { ok: violations.length === 0, violations };
}
