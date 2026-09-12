function hostedRetentionInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new TypeError(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function readHostedCoordinationEventRetentionPolicy(
  environment: Readonly<Record<string, string | undefined>>
) {
  return Object.freeze({
    intervalMs: hostedRetentionInteger(
      environment,
      'HOSTED_COORDINATION_EVENT_RETENTION_INTERVAL_MS',
      60_000,
      50,
      86_400_000
    ),
    maxRetainedEvents: hostedRetentionInteger(
      environment,
      'HOSTED_COORDINATION_EVENT_RETENTION_MAX_EVENTS',
      10_000,
      1,
      1_000_000
    ),
  });
}
