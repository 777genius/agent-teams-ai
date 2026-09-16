import { describe, expect, it } from 'vitest';

import {
  inspectOpenCodeUpstream,
  renderReport,
} from '../../scripts/ci/check-hosted-opencode-upstream.mjs';

const lock = {
  runtime: 'opencode',
  version: '1.18.4-agentteams.1',
  source: { repository: '777genius/opencode-anomaly' },
};

describe('hosted OpenCode upstream tracker', () => {
  it('reports a newer stable upstream without treating the downstream suffix as a release', () => {
    const result = inspectOpenCodeUpstream(lock, {
      tag_name: 'v1.18.21',
      html_url: 'https://github.com/anomalyco/opencode/releases/tag/v1.18.21',
    });

    expect(result).toMatchObject({ drifted: true, pinnedTag: 'v1.18.4', latestTag: 'v1.18.21' });
    expect(renderReport(result)).toContain('UPDATE REQUIRED');
  });

  it('stays current on the same upstream base and rejects ambiguous metadata', () => {
    expect(
      inspectOpenCodeUpstream(lock, {
        tag_name: 'v1.18.4',
        html_url: 'https://github.com/anomalyco/opencode/releases/tag/v1.18.4',
      }).drifted
    ).toBe(false);
    expect(() => inspectOpenCodeUpstream(lock, { tag_name: 'latest', html_url: 'x' })).toThrow(
      'hosted_opencode_upstream_metadata_invalid'
    );
  });
});
