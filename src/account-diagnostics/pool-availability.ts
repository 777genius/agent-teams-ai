import type {
  ProviderAccountAction,
  ProviderAccountAvailability,
  ProviderAccountDiagnostic,
} from "./types";

export type ProviderAccountPoolDecision =
  | "schedule"
  | "wait"
  | "relogin"
  | "inspect";

export type ProviderAccountPoolAvailabilitySummary = {
  readonly checkedAt: Date;
  readonly total: number;
  readonly schedulerEligibleCount: number;
  readonly schedulerEligibleSlotIds: readonly string[];
  readonly limitedSlotIds: readonly string[];
  readonly reconnectRequiredSlotIds: readonly string[];
  readonly inspectSlotIds: readonly string[];
  readonly nextAvailableAt?: Date;
  readonly nextAvailableSlotIds: readonly string[];
  readonly decision: ProviderAccountPoolDecision;
  readonly recommendedAction: ProviderAccountAction | "schedule";
  readonly safeToSchedule: boolean;
  readonly safeMessage: string;
};

export function summarizeProviderAccountPoolAvailability(input: {
  readonly diagnostics: readonly ProviderAccountDiagnostic[];
  readonly checkedAt: Date;
}): ProviderAccountPoolAvailabilitySummary {
  const schedulerEligible = input.diagnostics.filter(
    (diagnostic) => diagnostic.schedulerEligible,
  );
  const limited = input.diagnostics.filter(
    (diagnostic) => diagnostic.availability === "limited",
  );
  const reconnectRequired = input.diagnostics.filter(
    (diagnostic) => diagnostic.availability === "reconnect_required",
  );
  const inspect = input.diagnostics.filter((diagnostic) =>
    inspectableAvailability(diagnostic.availability)
  );
  const nextAvailableAt = earliestReset(limited);
  const decision = poolDecision({
    schedulerEligibleCount: schedulerEligible.length,
    limitedCount: limited.length,
    reconnectRequiredCount: reconnectRequired.length,
  });

  return {
    checkedAt: input.checkedAt,
    total: input.diagnostics.length,
    schedulerEligibleCount: schedulerEligible.length,
    schedulerEligibleSlotIds: schedulerEligible.map((diagnostic) => diagnostic.slotId),
    limitedSlotIds: limited.map((diagnostic) => diagnostic.slotId),
    reconnectRequiredSlotIds: reconnectRequired.map((diagnostic) => diagnostic.slotId),
    inspectSlotIds: inspect.map((diagnostic) => diagnostic.slotId),
    ...(nextAvailableAt ? { nextAvailableAt } : {}),
    nextAvailableSlotIds: nextAvailableAt
      ? limited
        .filter(
          (diagnostic) =>
            diagnostic.limitResetAt?.getTime() === nextAvailableAt.getTime(),
        )
        .map((diagnostic) => diagnostic.slotId)
      : [],
    decision,
    recommendedAction: recommendedActionForPoolDecision(decision),
    safeToSchedule: schedulerEligible.length > 0,
    safeMessage: poolSafeMessage({
      decision,
      schedulerEligibleCount: schedulerEligible.length,
      total: input.diagnostics.length,
      limitedCount: limited.length,
      reconnectRequiredCount: reconnectRequired.length,
      inspectCount: inspect.length,
      ...(nextAvailableAt ? { nextAvailableAt } : {}),
    }),
  };
}

function inspectableAvailability(
  availability: ProviderAccountAvailability,
): boolean {
  return (
    availability === "auth_unknown" ||
    availability === "unhealthy" ||
    availability === "unknown"
  );
}

function earliestReset(
  diagnostics: readonly ProviderAccountDiagnostic[],
): Date | undefined {
  let earliest: Date | undefined;
  for (const diagnostic of diagnostics) {
    const reset = diagnostic.limitResetAt;
    if (!reset) continue;
    if (!earliest || reset.getTime() < earliest.getTime()) {
      earliest = reset;
    }
  }
  return earliest;
}

function poolDecision(input: {
  readonly schedulerEligibleCount: number;
  readonly limitedCount: number;
  readonly reconnectRequiredCount: number;
}): ProviderAccountPoolDecision {
  if (input.schedulerEligibleCount > 0) return "schedule";
  if (input.reconnectRequiredCount > 0) return "relogin";
  if (input.limitedCount > 0) return "wait";
  return "inspect";
}

function recommendedActionForPoolDecision(
  decision: ProviderAccountPoolDecision,
): ProviderAccountAction | "schedule" {
  switch (decision) {
    case "schedule":
      return "schedule";
    case "wait":
      return "wait";
    case "relogin":
      return "relogin";
    case "inspect":
      return "inspect";
  }
}

function poolSafeMessage(input: {
  readonly decision: ProviderAccountPoolDecision;
  readonly schedulerEligibleCount: number;
  readonly total: number;
  readonly limitedCount: number;
  readonly reconnectRequiredCount: number;
  readonly inspectCount: number;
  readonly nextAvailableAt?: Date;
}): string {
  switch (input.decision) {
    case "schedule":
      return `${input.schedulerEligibleCount}/${input.total} account slots are scheduler eligible.`;
    case "relogin":
      return `${input.reconnectRequiredCount} account slots require relogin before scheduling.`;
    case "wait":
      return input.nextAvailableAt
        ? `${input.limitedCount} account slots are limited; next reset is ${input.nextAvailableAt.toISOString()}.`
        : `${input.limitedCount} account slots are limited and have no known reset time.`;
    case "inspect":
      return `${input.inspectCount}/${input.total} account slots need inspection before scheduling.`;
  }
}
