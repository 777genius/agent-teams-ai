export const HOSTED_READINESS_DIMENSIONS = Object.freeze([
  'live',
  'serve',
  'auth',
  'read',
  'mutation',
  'runtime-control',
  'machine-ingress',
  'recovery-point',
] as const);

export type HostedReadinessDimension = (typeof HOSTED_READINESS_DIMENSIONS)[number];
export type HostedReadinessCapability = HostedReadinessDimension | 'terminal';
export type HostedReadinessStatus = 'not_offered' | 'not_ready' | 'ready';

export interface HostedReadinessDimensionState {
  readonly dimension: HostedReadinessDimension;
  readonly status: 'not_ready' | 'ready';
  readonly reasons: readonly string[];
}

export interface HostedTerminalReadinessState {
  readonly dimension: 'terminal';
  readonly status: 'not_offered';
  readonly reasons: readonly [];
}

export type HostedReadinessState = HostedReadinessDimensionState | HostedTerminalReadinessState;

export type HostedReadinessDimensionStates = Readonly<{
  [TDimension in HostedReadinessDimension]: HostedReadinessDimensionState;
}> &
  Readonly<{
    terminal: HostedTerminalReadinessState;
  }>;

export const HOSTED_TERMINAL_READINESS: HostedTerminalReadinessState = Object.freeze({
  dimension: 'terminal',
  status: 'not_offered',
  reasons: Object.freeze([] as const),
});

export function isHostedReadinessDimension(value: unknown): value is HostedReadinessDimension {
  return HOSTED_READINESS_DIMENSIONS.some((dimension) => dimension === value);
}
