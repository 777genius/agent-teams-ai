import { IpcError } from '@renderer/utils/unwrapIpc';

function getErrorMessage(error: unknown): string {
  return error instanceof IpcError ? error.message : error instanceof Error ? error.message : '';
}

export function mapSendMessageError(error: unknown): string {
  const message = getErrorMessage(error);
  if (message.includes('Failed to verify inbox write')) {
    return 'Message was written but not verified (race). Please try again.';
  }
  return message || 'Failed to send message';
}

export function mapReviewError(error: unknown): string {
  const message = getErrorMessage(error);
  if (message.includes('Task status update verification failed')) {
    return 'Failed to update task status (possible agent conflict).';
  }
  return message || 'Failed to perform review action';
}

export function shouldInvalidateCachedTeamDataForError(
  teamName: string,
  message: string
): boolean {
  return (
    message === 'TEAM_DRAFT' ||
    message.includes('TEAM_DRAFT') ||
    message === `Team not found: ${teamName}` ||
    message === 'Team config not found'
  );
}
