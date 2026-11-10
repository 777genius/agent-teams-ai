import { describe, expect, it } from 'vitest';

import { getSharedTelemetryBuildProperties } from '../buildMetadata';

describe('build metadata telemetry properties', () => {
  it('includes the canonical GitHub repository for warehouse joins', () => {
    expect(getSharedTelemetryBuildProperties()).toMatchObject({
      app_name: 'agent-teams-ai',
      git_repository: '777genius/agent-teams-ai',
    });
  });
});
