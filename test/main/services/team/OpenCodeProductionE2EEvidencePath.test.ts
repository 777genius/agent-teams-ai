import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  OPENCODE_PRODUCTION_E2E_EVIDENCE_FILE,
  OPENCODE_PRODUCTION_E2E_EVIDENCE_PATH_ENV,
  resolveOpenCodeProductionE2EEvidencePath,
} from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidencePath';

describe('OpenCodeProductionE2EEvidencePath', () => {
  it('defaults to the app-owned bridge control directory', () => {
    expect(
      resolveOpenCodeProductionE2EEvidencePath({
        bridgeControlDir: '/app/user-data/opencode-bridge',
        env: {},
      })
    ).toBe(path.join('/app/user-data/opencode-bridge', OPENCODE_PRODUCTION_E2E_EVIDENCE_FILE));
  });

  it('allows release and local proof runs to point production at an explicit artifact', () => {
    const relativeOverride = 'tmp/opencode-production-evidence.json';

    expect(
      resolveOpenCodeProductionE2EEvidencePath({
        bridgeControlDir: '/app/user-data/opencode-bridge',
        env: {
          [OPENCODE_PRODUCTION_E2E_EVIDENCE_PATH_ENV]: ` ${relativeOverride} `,
        },
      })
    ).toBe(path.resolve(relativeOverride));
  });
});
