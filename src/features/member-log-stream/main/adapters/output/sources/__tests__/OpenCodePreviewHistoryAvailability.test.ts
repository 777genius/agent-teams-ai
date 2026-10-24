import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { DEFAULT_MEMBER_LOG_PREVIEW_BUDGET } from '../../../../../core/domain/models/MemberLogPreviewBudget';
import { OpenCodeMemberRuntimePreviewSource } from '../OpenCodeMemberRuntimePreviewSource';

import { cleanupMemberLogFixtureRoots, createTempClaudeRoot } from './memberLogFixtureFiles';

afterEach(cleanupMemberLogFixtureRoots);

// Losing a real inbox source must remain visible even when no provider binary is available.
it('distinguishes a proven empty inbox from unavailable inbox history in preview warnings', async () => {
  const root = await createTempClaudeRoot();
  const bridge = { getOpenCodeTranscript: vi.fn() };
  const input = {
    teamName: 'alpha-team',
    memberName: 'alice',
    laneId: 'secondary:opencode:alice',
    budget: DEFAULT_MEMBER_LOG_PREVIEW_BUDGET,
    maxItems: 3,
    textLimit: 200,
  };
  const source = new OpenCodeMemberRuntimePreviewSource(bridge as never, {
    resolve: vi.fn().mockResolvedValue(null),
  });
  const empty = await source.loadPreview(input);
  expect(empty.warnings).toEqual([
    { code: 'opencode_runtime_unavailable', message: 'OpenCode runtime bridge is unavailable.' },
  ]);

  await rm(join(root, 'teams', 'alpha-team', 'inboxes'), { recursive: true });
  const unavailable = await source.loadPreview({ ...input, forceRefresh: true });
  expect(unavailable.status).toBe('skipped');
  expect(unavailable.warnings).toContainEqual({
    code: 'opencode_runtime_unavailable',
    message:
      'OpenCode visible activity preview is unavailable: TEAM_HISTORY_UNAVAILABLE:listing_failed',
  });
  expect(bridge.getOpenCodeTranscript).not.toHaveBeenCalled();
});
