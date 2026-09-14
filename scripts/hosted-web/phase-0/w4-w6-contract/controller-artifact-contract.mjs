import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, '../../../..');
export const controllerArtifactContractPath =
  'docs/research/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.json';

export function loadControllerArtifactContract(root = repositoryRoot) {
  return JSON.parse(readFileSync(resolve(root, controllerArtifactContractPath), 'utf8'));
}

export function controllerArtifactContractSha256(root = repositoryRoot) {
  return createHash('sha256')
    .update(readFileSync(resolve(root, controllerArtifactContractPath)))
    .digest('hex');
}

export function validateArtifactProjection(controllerContract, projection) {
  const violations = [];
  const expectedFields = controllerContract.artifactFields;
  const projectedArtifacts = projection ?? [];
  const expected = new Map(
    controllerContract.artifacts.map((artifact) => [artifact.artifactId, artifact])
  );
  const actual = new Map(projectedArtifacts.map((artifact) => [artifact.artifactId, artifact]));

  for (const artifactId of new Set(projectedArtifacts.map((artifact) => artifact.artifactId))) {
    if (projectedArtifacts.filter((artifact) => artifact.artifactId === artifactId).length > 1) {
      violations.push(`duplicate_artifact:${artifactId}`);
    }
  }

  for (const artifactId of expected.keys()) {
    if (!actual.has(artifactId)) violations.push(`missing_artifact:${artifactId}`);
  }
  for (const artifactId of actual.keys()) {
    if (!expected.has(artifactId)) violations.push(`extra_artifact:${artifactId}`);
  }
  for (const [artifactId, expectedArtifact] of expected) {
    const actualArtifact = actual.get(artifactId);
    if (!actualArtifact) continue;
    const actualFields = Object.keys(actualArtifact);
    for (const field of expectedFields) {
      if (!Object.hasOwn(actualArtifact, field)) {
        violations.push(`missing_field:${artifactId}:${field}`);
      }
    }
    for (const field of actualFields) {
      if (!expectedFields.includes(field)) violations.push(`extra_field:${artifactId}:${field}`);
    }
    for (const field of expectedFields) {
      if (
        Object.hasOwn(actualArtifact, field) &&
        JSON.stringify(actualArtifact[field]) !== JSON.stringify(expectedArtifact[field])
      ) {
        violations.push(`value_mismatch:${artifactId}:${field}`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

export function validateControllerArtifactProjection(
  controllerContract,
  projection,
  root = repositoryRoot
) {
  const violations = [];
  if (projection?.controllerContractPath !== controllerArtifactContractPath) {
    violations.push('controller_contract_path');
  }
  if (projection?.controllerContractSha256 !== controllerArtifactContractSha256(root)) {
    violations.push('controller_contract_hash');
  }
  const artifactResult = validateArtifactProjection(controllerContract, projection?.artifacts);
  violations.push(...artifactResult.violations);
  return { ok: violations.length === 0, violations };
}
