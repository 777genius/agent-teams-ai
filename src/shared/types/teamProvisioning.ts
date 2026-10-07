export interface RuntimeSelectionVersioned {
  /** New drafts require an explicit provider; absent preserves legacy defaults. */
  runtimeSelectionVersion?: 1;
}

export interface LocalModelLaunchOptions extends RuntimeSelectionVersioned {
  allowExperimentalLocalModels?: boolean;
}

export interface LocalModelIssueMetadata {
  experimentalOverrideAvailable?: boolean;
}
export type TeamProvisioningModelVerificationMode = 'compatibility' | 'deep';
export type TeamProvisioningPrepareIssueScope = 'provider' | 'model';
export type TeamProvisioningPrepareIssueSeverity = 'blocking' | 'warning';
