const defaultObservationConcurrency = 4;
const maximumObservationConcurrency = 16;

export async function mapCodexGoalObservations<Input, Output>(
  values: readonly Input[],
  mapper: (value: Input, index: number) => Promise<Output>,
  concurrency = codexGoalObservationConcurrency(),
): Promise<Output[]> {
  if (values.length === 0) return [];
  const outputs = new Array<Output>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index] as Input;
      outputs[index] = await mapper(value, index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(normalizedConcurrency(concurrency), values.length) },
      () => worker(),
    ),
  );
  return outputs;
}

export function codexGoalObservationConcurrency(): number {
  const configured = Number(
    process.env.SUBSCRIPTION_RUNTIME_CODEX_OBSERVATION_CONCURRENCY ?? "",
  );
  return normalizedConcurrency(configured);
}

function normalizedConcurrency(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return defaultObservationConcurrency;
  return Math.min(Math.floor(value), maximumObservationConcurrency);
}
