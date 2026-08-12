export const HOSTED_V1_BROWSER_SUITES = Object.freeze({
  core: Object.freeze({
    testMatch: 'hosted-v1.spec.ts',
    authModes: ['personal', 'oidc', 'oidc-viewer'] as const,
    cases: Object.freeze([{ id: 'core', grep: null }] as const),
  }),
  'phase-6': Object.freeze({
    testMatch: 'phase-6-security.spec.ts',
    authModes: ['personal'] as const,
    cases: Object.freeze([
      {
        id: 'auth-rotation-reset',
        grep: 'Phase 6 uses browser storage and real network responses',
      },
      {
        id: 'workspace-lifecycle-bind-mount',
        grep: 'Hosted lifecycle fixture keeps its admitted fake-runtime effect on the pinned bind mount',
      },
    ] as const),
  }),
  'phase-8': Object.freeze({
    testMatch: 'phase-8-events.spec.ts',
    authModes: ['personal'] as const,
    cases: Object.freeze([
      { id: 'provider-task-write', grep: 'Phase 8 provider task external writes' },
      { id: 'provider-inbox-write', grep: 'Phase 8 provider inbox external writes' },
      { id: 'restart-replay', grep: 'Phase 8 SSE replay survives' },
      {
        id: 'lifecycle-recovery',
        grep: 'Phase 8 lifecycle recovery survives',
      },
      { id: 'retention-resync', grep: 'Phase 8 production retention expiry' },
      { id: 'slow-consumer', grep: 'Phase 8 production SSE bounds' },
    ] as const),
  }),
});

export type HostedV1BrowserSuite = keyof typeof HOSTED_V1_BROWSER_SUITES;

export function parseHostedV1BrowserSuite(value: string | undefined): HostedV1BrowserSuite {
  const suite = value ?? 'core';
  if (!Object.hasOwn(HOSTED_V1_BROWSER_SUITES, suite)) {
    throw new Error('HOSTED_E2E_SUITE must be core, phase-6, or phase-8');
  }
  return suite as HostedV1BrowserSuite;
}
