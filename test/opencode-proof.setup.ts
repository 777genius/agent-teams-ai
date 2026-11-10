import { beforeEach, vi } from 'vitest';

import { assertOwnedSmokeEnvironment } from './main/services/team/openCodeMixedTeamEvidence';

// Preserve validated HOME/USERPROFILE and leave cleanup to the owning wrapper.
// Guard in setup also runs before live test modules import application services.
const kind = process.env.OPENCODE_E2E_FULL_TEAM === '1' ? 'FULL' : 'MIXED';
await assertOwnedSmokeEnvironment(process.env, kind);
beforeEach(async () => {
  await assertOwnedSmokeEnvironment(process.env, kind);
});

// Sentry's Electron imports require a real Electron process. Keep only the essential stubs.
const sentryNoOp = vi.hoisted(() => ({
  IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  setTags: vi.fn(),
  close: vi.fn(() => Promise.resolve(true)),
  startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
  withScope: vi.fn((fn: (scope: unknown) => void) => fn({ setContext: vi.fn() })),
  browserTracingIntegration: vi.fn(() => ({
    name: 'BrowserTracing', setup: vi.fn(), afterAllSetup: vi.fn(),
  })),
}));
vi.mock('@sentry/electron/main', () => sentryNoOp);
vi.mock('@sentry/electron/renderer', () => sentryNoOp);
vi.mock('@sentry/react', () => sentryNoOp);
