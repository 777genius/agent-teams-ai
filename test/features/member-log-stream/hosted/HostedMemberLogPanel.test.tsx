import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
  HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
  HOSTED_MEMBER_LOG_SCHEMA_VERSION,
  hostedMemberLogPageByteLength,
  parseHostedMemberLogEntryId,
  parseHostedMemberLogSelectionId,
  parseHostedMemberLogSourceGeneration,
} from '@features/member-log-stream/contracts/hosted';
import {
  HostedMemberLogPanel,
  type HostedMemberLogTransport,
} from '@features/member-log-stream/renderer/hosted';
import { parseMemberId, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectionId = parseHostedMemberLogSelectionId(`member_log_selection_${'1'.repeat(32)}`);
const teamId = parseTeamId(`team_${'2'.repeat(32)}`);
const memberId = parseMemberId(`member_${'3'.repeat(32)}`);

function page() {
  const entry = Object.freeze({
    teamId,
    memberId,
    entryId: parseHostedMemberLogEntryId(`member_log_${'4'.repeat(32)}`),
    level: 'info' as const,
    occurredAtMs: 1,
    text: 'bounded member output',
  });
  let usedBytes = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = Object.freeze({
      schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
      kind: 'member_log_page' as const,
      selectionId,
      teamId,
      memberId,
      sourceGeneration: parseHostedMemberLogSourceGeneration('generation_panel'),
      revision: parseRevision('revision_panel'),
      entries: Object.freeze([entry]),
      nextCursor: null,
      truncated: false,
      truncationReasons: Object.freeze([]),
      budget: Object.freeze({
        itemLimit: 25,
        byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
        timeLimitMs: HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
        usedItems: 1,
        usedBytes,
        elapsedMs: 1,
      }),
    });
    const measured = hostedMemberLogPageByteLength(value);
    if (measured === usedBytes) return value;
    usedBytes = measured;
  }
  throw new Error('member-log-panel-page-size-did-not-converge');
}

describe('HostedMemberLogPanel', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders only the bounded transport projection through reusable controls', async () => {
    const getPage = vi
      .fn<HostedMemberLogTransport['getPage']>()
      .mockResolvedValue({ kind: 'success', page: page() });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<HostedMemberLogPanel selectionId={selectionId} transport={{ getPage }} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('bounded member output');
    expect(host.querySelector('button[aria-label="Refresh member log"]')).not.toBeNull();
    expect(host.querySelector('[title]')).toBeNull();
    expect(getPage).toHaveBeenCalledWith(
      expect.objectContaining({ selectionId }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    act(() => root.unmount());
  });
});
