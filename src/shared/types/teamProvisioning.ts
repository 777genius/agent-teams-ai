export interface LocalModelLaunchOptions {
  allowExperimentalLocalModels?: boolean;
  rosterLaunchBinding?: import('./rosterAuthorizationTransaction').RosterAuthorizedLaunchBinding;
}

export interface RosterBoundLaunchResponse {
  rosterLaunchOutcome?: import('./rosterAuthorizationTransaction').RosterAuthorizedLaunchResult;
}

export interface LocalModelIssueMetadata {
  experimentalOverrideAvailable?: boolean;
}
export type TeamProvisioningModelVerificationMode = 'compatibility' | 'deep';
export type TeamProvisioningPrepareIssueScope = 'provider' | 'model';
export type TeamProvisioningPrepareIssueSeverity = 'blocking' | 'warning';
