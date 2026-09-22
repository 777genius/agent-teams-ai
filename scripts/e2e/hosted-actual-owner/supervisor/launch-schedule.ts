// Shared fixed schedule. Importable inside the private namespace without schema I/O.
export const OWNER_RESTART_BOUNDARIES = Object.freeze([
  'initial',
  'after-pending-before-decision',
  'after-decision-before-provider',
  'after-effect-before-owner-recording',
] as const);
export const CHROMIUM_DESCENDANT_ROLES = Object.freeze([
  'chromium-browser',
  'chromium-network',
  'chromium-gpu',
  'chromium-renderer',
] as const);

export const ROOT_PROCESS_SCHEDULE = Object.freeze([
  {
    role: 'opencode',
    instanceId: 'opencode-1',
    generation: 1,
    restartBoundary: 'initial',
  },
  {
    role: 'owner',
    instanceId: 'owner-1',
    generation: 1,
    restartBoundary: 'initial',
  },
  {
    role: 'product',
    instanceId: 'product-1',
    generation: 1,
    restartBoundary: 'initial',
  },
  {
    role: 'browser',
    instanceId: 'browser-1',
    generation: 1,
    restartBoundary: 'initial',
  },
  {
    role: 'owner',
    instanceId: 'owner-2',
    generation: 2,
    restartBoundary: OWNER_RESTART_BOUNDARIES[1],
  },
  {
    role: 'owner',
    instanceId: 'owner-3',
    generation: 3,
    restartBoundary: OWNER_RESTART_BOUNDARIES[2],
  },
  {
    role: 'owner',
    instanceId: 'owner-4',
    generation: 4,
    restartBoundary: OWNER_RESTART_BOUNDARIES[3],
  },
] as const);
