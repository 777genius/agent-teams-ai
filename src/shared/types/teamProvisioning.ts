export interface LocalModelLaunchOptions {
  allowExperimentalLocalModels?: boolean;
}

export interface LocalModelIssueMetadata {
  experimentalOverrideAvailable?: boolean;
}
export type TeamProvisioningModelVerificationMode = 'compatibility' | 'deep';
export type TeamProvisioningPrepareIssueScope = 'provider' | 'model';
export type TeamProvisioningPrepareIssueSeverity = 'blocking' | 'warning';
