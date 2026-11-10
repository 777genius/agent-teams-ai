// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';

import * as sentryMain from '@sentry/electron/main';
import * as sentryRenderer from '@sentry/electron/renderer';
import * as sentryReact from '@sentry/react';
import { expect, it, vi } from 'vitest';

import { assertOwnedSmokeEnvironment } from '../../main/services/team/openCodeMixedTeamEvidence';

// Harmless subprocess probe. Never import a live suite, harness, provider or application service.
// Ordinary repository tests skip it; the Node integration supplies synthetic wrapper state.
it.skipIf(process.env.OPENCODE_E2E !== '1')('preserves wrapper ownership across real Vitest setup', async () => {
  const kind = process.env.OPENCODE_E2E_FULL_TEAM === '1' ? 'FULL' : 'MIXED';
  await assertOwnedSmokeEnvironment(process.env, kind);
  const root = process.env.OPENCODE_E2E_OWNED_ROOT!;
  expect(process.env.HOME).toBe(path.join(root, 'home'));
  expect(process.env.USERPROFILE).toBe(path.join(root, 'userprofile'));
  expect(process.env.AGENT_TEAMS_VITEST_TEMP_CLEANUP_DONE).toBeUndefined();
  for (const sentry of [sentryMain, sentryRenderer, sentryReact]) {
    expect(vi.isMockFunction(sentry.init)).toBe(true);
    expect(vi.isMockFunction(sentry.captureException)).toBe(true);
  }
  fs.writeFileSync(path.join(process.env.OPENCODE_E2E_PROOF_DIRECTORY!, 'boundary.json'),
    JSON.stringify({ kind, guardPassed: true, sentryStubbed: true }), { flag: 'wx' });
});
