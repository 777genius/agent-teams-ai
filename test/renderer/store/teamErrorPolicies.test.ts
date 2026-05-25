import { describe, expect, it } from 'vitest';

import {
  mapReviewError,
  mapSendMessageError,
  shouldInvalidateCachedTeamDataForError,
} from '../../../src/renderer/store/team/teamErrorPolicies';
import { IpcError } from '../../../src/renderer/utils/unwrapIpc';

describe('teamErrorPolicies', () => {
  it('maps send-message verification races to the user-facing retry copy', () => {
    expect(mapSendMessageError(new Error('Failed to verify inbox write for message-1'))).toBe(
      'Message was written but not verified (race). Please try again.'
    );
    expect(
      mapSendMessageError(
        new IpcError('team:sendMessage', 'Failed to verify inbox write after timeout')
      )
    ).toBe('Message was written but not verified (race). Please try again.');
  });

  it('maps send-message errors to original messages or fallback copy', () => {
    expect(mapSendMessageError(new Error('Transport failed'))).toBe('Transport failed');
    expect(mapSendMessageError('plain failure')).toBe('Failed to send message');
    expect(mapSendMessageError(null)).toBe('Failed to send message');
  });

  it('maps review verification conflicts to the user-facing conflict copy', () => {
    expect(mapReviewError(new Error('Task status update verification failed for task-1'))).toBe(
      'Failed to update task status (possible agent conflict).'
    );
    expect(
      mapReviewError(
        new IpcError('team:updateKanban', 'Task status update verification failed after retry')
      )
    ).toBe('Failed to update task status (possible agent conflict).');
  });

  it('maps review errors to original messages or fallback copy', () => {
    expect(mapReviewError(new Error('Review failed'))).toBe('Review failed');
    expect(mapReviewError({ message: 'ignored non-error shape' })).toBe(
      'Failed to perform review action'
    );
    expect(mapReviewError(undefined)).toBe('Failed to perform review action');
  });

  it('invalidates cached team data for draft and missing-team errors', () => {
    expect(shouldInvalidateCachedTeamDataForError('my-team', 'TEAM_DRAFT')).toBe(true);
    expect(
      shouldInvalidateCachedTeamDataForError('my-team', 'Cannot read team: TEAM_DRAFT')
    ).toBe(true);
    expect(shouldInvalidateCachedTeamDataForError('my-team', 'Team not found: my-team')).toBe(true);
    expect(shouldInvalidateCachedTeamDataForError('my-team', 'Team config not found')).toBe(true);
  });

  it('does not invalidate cached team data for unrelated or other-team errors', () => {
    expect(shouldInvalidateCachedTeamDataForError('my-team', 'Network timeout')).toBe(false);
    expect(shouldInvalidateCachedTeamDataForError('my-team', 'Team not found: other-team')).toBe(
      false
    );
    expect(shouldInvalidateCachedTeamDataForError('my-team', 'Team config missing')).toBe(false);
  });
});
