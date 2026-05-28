import type {
  HostedGitHubActionStatus,
  HostedGitHubActionStatusDto,
  HostedGitHubAvailableRepositoryDto,
  HostedGitHubConnectionDto,
  HostedGitHubRepositoryTargetDto,
  HostedGitHubRepositoryTargetStatus,
  HostedGitHubSetupSessionDto,
  HostedGitHubSetupState,
  HostedIntegrationSafeErrorDto,
} from './dto';

const nowIso = (): string => new Date().toISOString();

export function normalizeHostedSafeError(error: unknown): HostedIntegrationSafeErrorDto {
  if (isRecord(error)) {
    const code = typeof error.code === 'string' && error.code ? error.code : 'HOSTED_UNKNOWN_ERROR';
    const message =
      typeof error.message === 'string' && error.message
        ? error.message
        : 'Hosted integration request failed.';
    const category =
      typeof error.category === 'string' && isSafeErrorCategory(error.category)
        ? error.category
        : 'unknown';
    return {
      category,
      code,
      message,
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      ...(isSafeDetails(error.safeDetails) ? { safeDetails: error.safeDetails } : {}),
    };
  }
  return {
    category: 'unknown',
    code: 'HOSTED_UNKNOWN_ERROR',
    message: error instanceof Error ? error.message : 'Hosted integration request failed.',
  };
}

export function normalizeHostedGitHubSetupSession(
  value: unknown,
  fallbackSessionId = ''
): HostedGitHubSetupSessionDto {
  const input = isRecord(value) ? value : {};
  const setupSessionId = readString(input.setupSessionId) || fallbackSessionId;
  const state = normalizeSetupState(readString(input.state) || readString(input.status));
  const setupUrl = readString(input.setupUrl) || readString(input.installUrl);
  const safeError = input.safeError ?? input.safeFailure;
  return {
    setupSessionId,
    state,
    ...(setupUrl ? { setupUrl } : {}),
    ...(readString(input.expiresAt) ? { expiresAt: readString(input.expiresAt) } : {}),
    ...(readString(input.connectionId) ? { connectionId: readString(input.connectionId) } : {}),
    ...(safeError === undefined ? {} : { safeError: normalizeHostedSafeError(safeError) }),
    fetchedAt: nowIso(),
  };
}

export function normalizeHostedGitHubConnection(value: unknown): HostedGitHubConnectionDto {
  const input = isRecord(value) ? value : {};
  return {
    connectionId: readString(input.connectionId) || readString(input.id),
    provider: 'github',
    githubAccountId: readString(input.githubAccountId),
    githubAccountLogin: readString(input.githubAccountLogin),
    githubAccountType: normalizeAccountType(readString(input.githubAccountType)),
    ...(readString(input.githubInstallationId)
      ? { githubInstallationId: readString(input.githubInstallationId) }
      : {}),
    ...(readString(input.repositorySelection)
      ? { repositorySelection: normalizeRepositorySelection(readString(input.repositorySelection)) }
      : {}),
    suspendedAt: readString(input.suspendedAt) || null,
    fetchedAt: nowIso(),
  };
}

export function normalizeHostedGitHubRepositoryTarget(
  value: unknown
): HostedGitHubRepositoryTargetDto {
  const input = isRecord(value) ? value : {};
  const target = isRecord(input.target) ? input.target : input;
  const binding = isRecord(input.binding) ? input.binding : input;
  return {
    targetId: readString(target.targetId) || readString(target.id),
    connectionId: readString(target.integrationConnectionId) || readString(target.connectionId),
    githubRepositoryId:
      readString(binding.githubRepositoryId) || readString(binding.providerRepositoryId),
    displayOwner: readString(binding.displayOwner),
    displayName: readString(binding.displayName),
    displayFullName: readString(binding.displayFullName),
    ...(typeof binding.private === 'boolean' ? { private: binding.private } : {}),
    ...(typeof binding.archived === 'boolean' ? { archived: binding.archived } : {}),
    status: normalizeTargetStatus(readString(target.status)),
    ...(readNumber(target.policyVersion)
      ? { policyVersion: readNumber(target.policyVersion) }
      : {}),
    ...(readString(binding.lastVerifiedAt)
      ? { lastVerifiedAt: readString(binding.lastVerifiedAt) }
      : {}),
    disabledAt: readString(target.disabledAt) || null,
    fetchedAt: nowIso(),
  };
}

export function normalizeHostedGitHubAvailableRepository(
  value: unknown,
  connectionId: string
): HostedGitHubAvailableRepositoryDto {
  const input = isRecord(value) ? value : {};
  const target = isRecord(input.target) ? input.target : {};
  const targetId =
    readString(input.targetId) || readString(target.targetId) || readString(target.id);
  return {
    connectionId,
    githubRepositoryId:
      readString(input.githubRepositoryId) || readString(input.providerRepositoryId),
    displayOwner: readString(input.displayOwner),
    displayName: readString(input.displayName),
    displayFullName: readString(input.displayFullName),
    ...(typeof input.private === 'boolean' ? { private: input.private } : {}),
    ...(typeof input.archived === 'boolean' ? { archived: input.archived } : {}),
    available: input.available !== false,
    ...(targetId ? { targetId } : {}),
    fetchedAt: nowIso(),
  };
}

export function normalizeHostedGitHubActionStatus(value: unknown): HostedGitHubActionStatusDto {
  const input = isRecord(value) ? value : {};
  const safeError = input.safeError ?? input.safeFailure;
  return {
    actionRequestId: readString(input.actionRequestId) || readString(input.id),
    ...(readString(input.requestId) ? { requestId: readString(input.requestId) } : {}),
    ...(readString(input.targetId) ? { targetId: readString(input.targetId) } : {}),
    ...(readString(input.actionType) ? { actionType: readString(input.actionType) } : {}),
    status: normalizeActionStatus(readString(input.status)),
    ...(readString(input.githubUrl) ? { githubUrl: readString(input.githubUrl) } : {}),
    ...(safeError === undefined ? {} : { safeError: normalizeHostedSafeError(safeError) }),
    ...(readString(input.createdAt) ? { createdAt: readString(input.createdAt) } : {}),
    ...(readString(input.updatedAt) ? { updatedAt: readString(input.updatedAt) } : {}),
    fetchedAt: nowIso(),
  };
}

function normalizeSetupState(value: string): HostedGitHubSetupState {
  if (
    value === 'idle' ||
    value === 'opening' ||
    value === 'pending_installation' ||
    value === 'pending_claim' ||
    value === 'connected' ||
    value === 'failed' ||
    value === 'expired' ||
    value === 'dismissed'
  ) {
    return value;
  }
  if (value === 'started') return 'pending_installation';
  if (value === 'install_url_created') return 'pending_installation';
  if (value === 'installation_callback_received' || value === 'claim_oauth_started') {
    return 'pending_claim';
  }
  if (value === 'claim_bound') return 'connected';
  if (value === 'failed' || value === 'oauth_failed' || value === 'claim_failed') return 'failed';
  if (value === 'completed') return 'connected';
  return 'idle';
}

function normalizeActionStatus(value: string): HostedGitHubActionStatus {
  if (
    value === 'queued' ||
    value === 'dispatching' ||
    value === 'processing' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'dead_lettered' ||
    value === 'cancelled'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeTargetStatus(value: string): HostedGitHubRepositoryTargetStatus {
  if (
    value === 'enabled' ||
    value === 'disabled' ||
    value === 'deleted' ||
    value === 'stale' ||
    value === 'revoked'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeAccountType(value: string): 'organization' | 'unknown' | 'user' {
  if (value === 'organization' || value === 'user') return value;
  return 'unknown';
}

function normalizeRepositorySelection(value: string): 'all' | 'selected' | 'unknown' {
  if (value === 'all' || value === 'selected') return value;
  return 'unknown';
}

function isSafeErrorCategory(value: string): value is HostedIntegrationSafeErrorDto['category'] {
  return (
    value === 'auth' ||
    value === 'configuration' ||
    value === 'network' ||
    value === 'security' ||
    value === 'unavailable' ||
    value === 'validation' ||
    value === 'version_mismatch' ||
    value === 'unknown'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isSafeDetails(value: unknown): value is Record<string, string | number | boolean | null> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        entry === null ||
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        typeof entry === 'boolean'
    )
  );
}
