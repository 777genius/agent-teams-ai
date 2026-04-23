import { describe, expect, it } from 'vitest';

import { buildPendingRuntimeSummaryCopy } from '@renderer/utils/teamLaunchSummaryCopy';

describe('buildPendingRuntimeSummaryCopy', () => {
  it('uses generic runtime confirmation wording instead of bootstrap-specific copy', () => {
    expect(
      buildPendingRuntimeSummaryCopy({
        confirmedCount: 2,
        expectedMemberCount: 4,
        runtimeAlivePendingCount: 2,
      })
    ).toBe(
      'Last launch is still reconciling - 2/4 teammates confirmed alive, 2 runtimes still awaiting confirmation'
    );
  });

  it('can emit the punctuated list-card variant', () => {
    expect(
      buildPendingRuntimeSummaryCopy({
        confirmedCount: 1,
        expectedMemberCount: 3,
        runtimeAlivePendingCount: 1,
        includePeriod: true,
      })
    ).toBe(
      'Last launch is still reconciling - 1/3 teammates confirmed alive, 1 runtime still awaiting confirmation.'
    );
  });
});
