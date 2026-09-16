import { TeamApplicationUnavailableError } from '@main/composition/team/TeamApplicationHost';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { HttpBadRequestError } from './teamRouteParsers';

export function getTeamHttpStatusCode(error: unknown, fallback: number = 500): number {
  if (error instanceof HttpBadRequestError) {
    return 400;
  }
  if (error instanceof TeamApplicationUnavailableError) {
    return 501;
  }
  if (isRuntimeControlProviderRoutingError(error)) {
    return 501;
  }
  if (error instanceof Error && error.name === 'RuntimeStaleEvidenceError') {
    return 409;
  }
  if (isTeamNotFoundError(error)) {
    return 404;
  }
  if (error instanceof Error && error.message.startsWith('Team already exists')) {
    return 409;
  }
  return fallback;
}

export function shouldLogTeamHttpError(
  error: unknown,
  statusCode: number = getTeamHttpStatusCode(error)
): boolean {
  return (
    statusCode >= 500 &&
    !(error instanceof TeamApplicationUnavailableError) &&
    !isRuntimeControlProviderRoutingError(error)
  );
}

export function getTeamHttpResponseErrorMessage(
  error: unknown,
  statusCode: number = getTeamHttpStatusCode(error)
): string {
  if (
    statusCode >= 500 &&
    !(error instanceof TeamApplicationUnavailableError) &&
    !isRuntimeControlProviderRoutingError(error)
  ) {
    return 'Internal server error';
  }
  return getErrorMessage(error);
}

function isRuntimeControlProviderRoutingError(error: unknown): boolean {
  return error instanceof Error && error.name === 'RuntimeControlProviderRoutingError';
}

function isTeamNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Team not found') || /^Team "[^"]+" not found\b/.test(error.message))
  );
}
