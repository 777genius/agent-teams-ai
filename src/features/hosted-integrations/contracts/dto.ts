export type HostedIntegrationSafeErrorCategory =
  | 'auth'
  | 'configuration'
  | 'network'
  | 'security'
  | 'unavailable'
  | 'validation'
  | 'version_mismatch'
  | 'unknown';

export interface HostedIntegrationSafeErrorDto {
  readonly category: HostedIntegrationSafeErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly safeDetails?: Record<string, string | number | boolean | null>;
}

export type HostedIntegrationAvailabilityStatus =
  | 'available'
  | 'disabled'
  | 'not_configured'
  | 'secure_store_unavailable'
  | 'unavailable'
  | 'version_mismatch';

export interface HostedIntegrationAvailabilityDto {
  readonly status: HostedIntegrationAvailabilityStatus;
  readonly reason?: HostedIntegrationSafeErrorDto;
  readonly contractVersion: string;
  readonly minimumSupportedContractVersion?: string;
}

export type HostedIntegrationSessionState =
  | 'paired'
  | 'revoked'
  | 'expired'
  | 'auth_failed'
  | 'unknown';

export interface HostedIntegrationDesktopSessionDto {
  readonly state: HostedIntegrationSessionState;
  readonly workspaceId: string;
  readonly desktopClientId: string;
  readonly workspaceDisplayName?: string;
  readonly desktopDisplayName?: string;
  readonly fetchedAt: string;
}

export type HostedGitHubSetupState =
  | 'idle'
  | 'opening'
  | 'pending_installation'
  | 'pending_claim'
  | 'connected'
  | 'failed'
  | 'expired'
  | 'dismissed';

export interface HostedGitHubSetupSessionDto {
  readonly setupSessionId: string;
  readonly state: HostedGitHubSetupState;
  readonly setupUrl?: string;
  readonly expiresAt?: string;
  readonly connectionId?: string;
  readonly safeError?: HostedIntegrationSafeErrorDto;
  readonly fetchedAt: string;
}

export interface HostedGitHubConnectionDto {
  readonly connectionId: string;
  readonly provider: 'github';
  readonly githubAccountId: string;
  readonly githubAccountLogin: string;
  readonly githubAccountType: 'user' | 'organization' | 'unknown';
  readonly githubInstallationId?: string;
  readonly repositorySelection?: 'all' | 'selected' | 'unknown';
  readonly suspendedAt?: string | null;
  readonly fetchedAt: string;
}

export type HostedGitHubRepositoryTargetStatus =
  | 'enabled'
  | 'disabled'
  | 'deleted'
  | 'stale'
  | 'revoked'
  | 'unknown';

export interface HostedGitHubRepositoryTargetDto {
  readonly targetId: string;
  readonly connectionId: string;
  readonly githubRepositoryId: string;
  readonly displayOwner: string;
  readonly displayName: string;
  readonly displayFullName: string;
  readonly private?: boolean;
  readonly archived?: boolean;
  readonly status: HostedGitHubRepositoryTargetStatus;
  readonly policyVersion?: number;
  readonly lastVerifiedAt?: string;
  readonly disabledAt?: string | null;
  readonly fetchedAt: string;
}

export interface HostedGitHubAvailableRepositoryDto {
  readonly connectionId: string;
  readonly githubRepositoryId: string;
  readonly displayOwner: string;
  readonly displayName: string;
  readonly displayFullName: string;
  readonly private?: boolean;
  readonly archived?: boolean;
  readonly available: boolean;
  readonly targetId?: string;
  readonly fetchedAt: string;
}

export type HostedGitHubActionStatus =
  | 'queued'
  | 'dispatching'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'dead_lettered'
  | 'cancelled'
  | 'unknown';

export interface HostedGitHubActionStatusDto {
  readonly actionRequestId: string;
  readonly requestId?: string;
  readonly targetId?: string;
  readonly actionType?: string;
  readonly status: HostedGitHubActionStatus;
  readonly githubUrl?: string;
  readonly safeError?: HostedIntegrationSafeErrorDto;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly fetchedAt: string;
}

export interface HostedIntegrationStateDto {
  readonly availability: HostedIntegrationAvailabilityDto;
  readonly controlPlaneBaseUrl?: string;
  readonly session?: HostedIntegrationDesktopSessionDto;
  readonly activeSetup?: HostedGitHubSetupSessionDto;
  readonly connections: readonly HostedGitHubConnectionDto[];
  readonly targets: readonly HostedGitHubRepositoryTargetDto[];
  readonly recentActions: readonly HostedGitHubActionStatusDto[];
  readonly fetchedAt: string;
}

export interface ConfigureHostedIntegrationRequestDto {
  readonly controlPlaneBaseUrl: string;
}

export interface BootstrapHostedWorkspaceRequestDto {
  readonly workspaceDisplayName?: string;
  readonly desktopDisplayName?: string;
}

export interface StartHostedPairingResponseDto {
  readonly pairingSessionId: string;
  readonly pairingCode: string;
  readonly expiresAt: string;
}

export interface CompleteHostedPairingRequestDto {
  readonly pairingCode: string;
  readonly desktopDisplayName?: string;
}

export interface RefreshGitHubSetupRequestDto {
  readonly setupSessionId: string;
}

export interface OpenHostedGitHubSetupUrlRequestDto {
  readonly setupSessionId: string;
  readonly setupUrl: string;
}

export interface ListAvailableHostedGitHubRepositoriesRequestDto {
  readonly connectionId: string;
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface EnableHostedGitHubRepositoryTargetRequestDto {
  readonly connectionId: string;
  readonly githubRepositoryId: string;
}

export interface DisableHostedGitHubRepositoryTargetRequestDto {
  readonly targetId: string;
  readonly reason?: string;
}

export interface GetHostedGitHubActionStatusRequestDto {
  readonly actionRequestId: string;
}

export type HostedGitHubActionType =
  | 'github.issue_comment.create'
  | 'github.pull_request_comment.create_top_level'
  | 'github.pull_request_review.create'
  | 'github.check_run.create_or_update';

export type HostedGitHubActionSubjectKind = 'agent' | 'team' | 'desktop-client' | 'workspace';

export interface HostedGitHubActionRuntimeMemberDto {
  readonly agentId?: string;
  readonly agentName: string;
  readonly teamId?: string;
  readonly teamName: string;
  readonly memberName?: string;
  readonly role?: string;
  readonly avatarUrl?: string;
}

export interface HostedGitHubActionCommandDto {
  readonly targetId: string;
  readonly actionType: HostedGitHubActionType;
  readonly payload: unknown;
  readonly localAttemptId: string;
  readonly runId?: string;
  readonly runtimeSessionId?: string;
  readonly memberName?: string;
  readonly correlationId?: string;
  readonly runtimeMember: HostedGitHubActionRuntimeMemberDto;
}

export interface HostedGitHubActionRequestEnvelopeDto {
  readonly requestId: string;
  readonly targetId: string;
  readonly actionType: HostedGitHubActionType;
  readonly requestedBy: {
    readonly subjectKind: HostedGitHubActionSubjectKind;
    readonly subjectId: string;
    readonly teamId?: string;
    readonly agentId?: string;
  };
  readonly attribution: {
    readonly agentDisplayName: string;
    readonly agentAvatarUrl?: string;
    readonly teamDisplayName?: string;
  };
  readonly payload: unknown;
  readonly correlationId?: string;
}
