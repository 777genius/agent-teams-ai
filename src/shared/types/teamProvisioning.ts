import type { BackendLaunchModelPreparation, BackendLaunchModelSelection } from '@features/agent-backend/contracts';

export type CapturedTeamModelPreparation = BackendLaunchModelPreparation;

/** A current dialog observation; allocation still requires the original Host evidence. */
export interface CapturedTeamReadiness {
  handleId: string;
  preparationId: string;
  launchId: string;
  rosterRevision: string;
  selectionSignature: string;
  expiresAt: number;
  /** Older observations remain displayable but cannot supply allocation references. */
  selections?: BackendLaunchModelSelection[];
}

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
