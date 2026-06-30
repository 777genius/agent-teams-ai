import type {
  ProviderAccountAction,
  ProviderAccountAvailability,
  ProviderAccountDiagnosticSignal,
  ProviderAccountDiagnosticSource,
  ProviderAccountProbeMode,
} from "./types";

export function chooseDiagnosticSignal(input: {
  readonly signals: readonly ProviderAccountDiagnosticSignal[];
  readonly probeMode: ProviderAccountProbeMode;
  readonly checkedAt: Date;
}): ProviderAccountDiagnosticSignal {
  const normalized = input.signals.filter(isActionableSignal);
  const live = normalized.find((signal) => signal.source === "live_probe");
  if (input.probeMode === "live_probe" && live) {
    return withCheckedAt(live, input.checkedAt);
  }

  const sorted = [...normalized].sort(compareSignals);
  const selected = sorted[0];
  if (selected) return withCheckedAt(selected, input.checkedAt);

  return {
    availability: "available",
    source: "cached",
    checkedAt: input.checkedAt,
  };
}

export function recommendedActionForAvailability(
  availability: ProviderAccountAvailability,
): ProviderAccountAction {
  switch (availability) {
    case "available":
      return "none";
    case "limited":
      return "wait";
    case "reconnect_required":
      return "relogin";
    case "auth_unknown":
    case "unhealthy":
    case "unknown":
      return "inspect";
  }
}

export function isSchedulerEligible(
  availability: ProviderAccountAvailability,
): boolean {
  return availability === "available";
}

export function accountAvailabilitySeverity(
  availability: ProviderAccountAvailability,
): number {
  switch (availability) {
    case "reconnect_required":
      return 100;
    case "auth_unknown":
      return 95;
    case "limited":
      return 90;
    case "unhealthy":
      return 80;
    case "unknown":
      return 40;
    case "available":
      return 10;
  }
}

function compareSignals(
  left: ProviderAccountDiagnosticSignal,
  right: ProviderAccountDiagnosticSignal,
): number {
  const severityDelta =
    accountAvailabilitySeverity(right.availability) -
    accountAvailabilitySeverity(left.availability);
  if (severityDelta !== 0) return severityDelta;

  const sourceDelta = sourcePriority(right.source) - sourcePriority(left.source);
  if (sourceDelta !== 0) return sourceDelta;

  const leftReset = left.limitResetAt?.getTime();
  const rightReset = right.limitResetAt?.getTime();
  if (leftReset === undefined && rightReset !== undefined) return 1;
  if (leftReset !== undefined && rightReset === undefined) return -1;
  if (leftReset !== undefined && rightReset !== undefined) {
    return rightReset - leftReset;
  }

  return 0;
}

function isActionableSignal(signal: ProviderAccountDiagnosticSignal): boolean {
  return signal.availability !== "available" || signal.source !== "cached";
}

function sourcePriority(source: ProviderAccountDiagnosticSource): number {
  switch (source) {
    case "live_probe":
      return 30;
    case "health":
      return 20;
    case "cached":
      return 10;
  }
}

function withCheckedAt(
  signal: ProviderAccountDiagnosticSignal,
  checkedAt: Date,
): ProviderAccountDiagnosticSignal {
  return {
    ...signal,
    checkedAt: signal.checkedAt ?? checkedAt,
  };
}
