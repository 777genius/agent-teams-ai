export const repositoryRoot: string;
export const controllerArtifactContractPath: string;

export type ArtifactRecord = Record<string, unknown> & { artifactId: string };

export interface ControllerArtifactContract {
  artifactFields: string[];
  artifacts: ArtifactRecord[];
}

export interface ControllerArtifactProjection {
  controllerContractPath?: string;
  controllerContractSha256?: string;
  artifacts?: Record<string, unknown>[];
}

export interface ContractValidationResult {
  ok: boolean;
  violations: string[];
}

export function loadControllerArtifactContract(root?: string): ControllerArtifactContract;
export function controllerArtifactContractSha256(root?: string): string;
export function validateArtifactProjection(
  controllerContract: ControllerArtifactContract,
  projection: ArtifactRecord[]
): ContractValidationResult;
export function validateControllerArtifactProjection(
  controllerContract: ControllerArtifactContract,
  projection: ControllerArtifactProjection,
  root?: string
): ContractValidationResult;
