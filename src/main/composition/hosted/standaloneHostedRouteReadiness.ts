import { HOSTED_READINESS_DIMENSIONS, HOSTED_TERMINAL_READINESS, type HostedReadinessDimensionStates } from './application';

export function createStandaloneHostedRouteReadiness(input: {
  readonly fatalFailStop: boolean;
  readonly runtimeIdentityAvailable: boolean;
  readonly diagnosticsAvailable: boolean;
  readonly lifecycleOwnerAvailable: boolean;
}): {
  readonly revision: number;
  readonly dimensions: HostedReadinessDimensionStates;
} {
  const { fatalFailStop, runtimeIdentityAvailable, diagnosticsAvailable, lifecycleOwnerAvailable } =
    input;
  const readiness = Object.fromEntries(
    HOSTED_READINESS_DIMENSIONS.map((dimension) => {
      const ready =
        !fatalFailStop &&
        (dimension === 'live' ||
          dimension === 'serve' ||
          dimension === 'auth' ||
          (dimension === 'read' && runtimeIdentityAvailable && diagnosticsAvailable) ||
          (dimension === 'mutation' && lifecycleOwnerAvailable) ||
          (dimension === 'runtime-control' && lifecycleOwnerAvailable));
      const reason = fatalFailStop
        ? 'fatal_fail_stop'
        : !runtimeIdentityAvailable
          ? 'runtime_identity_unavailable'
          : !diagnosticsAvailable
            ? 'diagnostics_unavailable'
            : runtimeIdentityAvailable
              ? 'external_orchestrator_unavailable'
              : 'runtime_identity_unavailable';
      return [
        dimension,
        Object.freeze({
          dimension,
          status: ready ? ('ready' as const) : ('not_ready' as const),
          reasons: Object.freeze(ready ? [] : [reason]),
        }),
      ];
    })
  );
  return Object.freeze({
    revision:
      (runtimeIdentityAvailable ? 1 : 0) +
      (diagnosticsAvailable ? 1 : 0) +
      (lifecycleOwnerAvailable ? 1 : 0),
    dimensions: Object.freeze({
      ...readiness,
      terminal: HOSTED_TERMINAL_READINESS,
    }) as HostedReadinessDimensionStates,
  });
}
