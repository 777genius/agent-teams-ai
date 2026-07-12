import {
  AgentProvider,
  QuotaLimitState,
  QuotaWindowKind,
} from "../../domain/enums";
import type { QuotaSnapshot, QuotaWindow } from "../../domain/model";

export function quotaSnapshotFromClaudeCodeStatusline(input: {
  readonly statuslineJson: unknown;
  readonly now: Date;
}): QuotaSnapshot | null {
  const root = readRecord(input.statuslineJson);
  const rateLimits = readRecord(root?.rate_limits);
  if (!rateLimits) return null;

  const windows: QuotaWindow[] = [];
  const fiveHour = claudeWindow(rateLimits.five_hour, QuotaWindowKind.FiveHour);
  const sevenDay = claudeWindow(rateLimits.seven_day, QuotaWindowKind.SevenDay);
  if (fiveHour) windows.push(fiveHour);
  if (sevenDay) windows.push(sevenDay);

  return {
    provider: AgentProvider.ClaudeCode,
    checkedAt: input.now,
    windows,
  };
}

function claudeWindow(
  value: unknown,
  kind: QuotaWindowKind,
): QuotaWindow | null {
  const record = readRecord(value);
  if (!record) return null;
  const usedPercent = numberValue(record.used_percentage);
  const resetsAt = timestampFromUnix(record.resets_at);
  return {
    kind,
    state:
      usedPercent !== undefined && usedPercent >= 100
        ? QuotaLimitState.Limited
        : QuotaLimitState.Clear,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampFromUnix(value: unknown): Date | undefined {
  const number = numberValue(value);
  if (number === undefined || number <= 0) return undefined;
  return new Date((number > 9_999_999_999 ? number : number * 1000));
}
