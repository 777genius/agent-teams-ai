import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CodexGoalRunConfig } from "./codex-goal-runner";

export function tagValues(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function putIfDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) target[key] = value;
}

export function accountNames(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function stringsFromValue(value: unknown): readonly string[] {
  return accountNames(value);
}

export function requiredString(value: unknown, name: string, cwd: string): string {
  return resolvePath(cwd, requiredRawString(value, name));
}

export function requiredRawString(value: unknown, name: string): string {
  const text = stringValue(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function dateValue(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function positiveIntegerValue(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function workerReportModeValue(
  value: unknown,
): CodexGoalRunConfig["workerReportMode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "runtime-only" || value === "structured-output") return value;
  throw new Error("workerReportMode must be runtime-only or structured-output");
}

export function resolvePath(cwd: string, value: string): string {
  const expanded = value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
