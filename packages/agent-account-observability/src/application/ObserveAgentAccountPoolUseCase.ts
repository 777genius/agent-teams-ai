import { ObservationPolicy } from "../domain/ObservationPolicy";
import type { AccountPoolObservation, AccountSlot } from "../domain/model";
import type {
  AccountInventoryPort,
  AgentAccountObserverPort,
  ObservationClock,
} from "./ports";

export class ObserveAgentAccountPoolUseCase {
  private readonly policy = new ObservationPolicy();

  constructor(
    private readonly dependencies: {
      readonly inventory: AccountInventoryPort;
      readonly observer: AgentAccountObserverPort;
      readonly clock?: ObservationClock;
    },
  ) {}

  async execute(input: {
    readonly provider?: AccountSlot["provider"];
    readonly timeoutMs?: number;
    readonly maxConcurrency?: number;
  } = {}): Promise<AccountPoolObservation> {
    const checkedAt = this.dependencies.clock?.now() ?? new Date();
    const accounts = await this.dependencies.inventory.listAccounts({
      ...(input.provider ? { provider: input.provider } : {}),
    });
    const observations = await mapWithConcurrency(
      accounts,
      Math.max(1, input.maxConcurrency ?? 1),
      (account) =>
        this.dependencies.observer.observe({
          account,
          now: checkedAt,
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        }),
    );

    return {
      checkedAt,
      observations,
      summary: this.policy.summarize(observations),
    };
  }
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await mapper(value);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return output;
}
