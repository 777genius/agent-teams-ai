import {
  getAttachmentMimeTypes,
  getAttachmentTotalSizeBytes,
  getTeamLifecycleAnalyticsContext,
} from '@renderer/analytics/teamAnalyticsMetadata';
import { describe, expect, it } from 'vitest';

import type { TeamViewSnapshot } from '@shared/types';

describe('teamAnalyticsMetadata', () => {
  it('prefers explicit attachment sizes and decodes supported base64 shapes', () => {
    expect(
      getAttachmentTotalSizeBytes([
        { size: 10, base64: 'ignored' },
        { data: 'aGVsbG8=' },
        { base64Data: 'data:text/plain;base64,aGk=' },
      ])
    ).toBe(17);
    expect(getAttachmentTotalSizeBytes([{ data: '' }])).toBeNull();
    expect(getAttachmentTotalSizeBytes(undefined)).toBeNull();
  });

  it('preserves MIME ordering and unknown entries', () => {
    expect(
      getAttachmentMimeTypes([{ mimeType: 'application/pdf' }, { type: 'image/png' }, {}])
    ).toEqual(['application/pdf', 'image/png', null]);
  });

  it('projects only lifecycle telemetry fields from a team snapshot', () => {
    const data: TeamViewSnapshot = {
      teamName: 'sandbox-team',
      config: { name: 'Sandbox Team' },
      members: [
        {
          name: 'alice',
          currentTaskId: 'task-1',
          taskCount: 1,
          providerId: 'codex',
        },
      ],
      tasks: [{ id: 'task-1', subject: 'Test task', status: 'in_progress' }],
      kanbanState: { teamName: 'sandbox-team', reviewers: [], tasks: {} },
      processes: [],
      isAlive: true,
    };

    expect(getTeamLifecycleAnalyticsContext(data)).toEqual({
      memberCount: 1,
      providerIds: ['codex'],
      runtimeActive: true,
      hadRunningTasks: true,
    });
    expect(getTeamLifecycleAnalyticsContext(null)).toEqual({
      memberCount: null,
      providerIds: [],
      runtimeActive: null,
      hadRunningTasks: null,
    });
  });
});
