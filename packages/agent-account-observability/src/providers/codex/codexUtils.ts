import { createHash } from "node:crypto";

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function nestedRecord(
  value: unknown,
  path: readonly string[],
): Record<string, unknown> | null {
  let current: unknown = value;
  for (const segment of path) {
    const record = readRecord(current);
    if (!record) return null;
    current = record[segment];
  }
  return readRecord(current);
}

export function nestedString(
  value: unknown,
  path: readonly string[],
): string | undefined {
  const parent = nestedRecord(value, path.slice(0, -1));
  const last = path[path.length - 1];
  return last ? stringValue(parent?.[last]) : undefined;
}

export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  return `${name.slice(0, 2)}***@${domain.slice(0, 2)}***`;
}

export function hashAccountKey(input: {
  readonly provider: string;
  readonly accountKey: string;
}): string {
  return createHash("sha256")
    .update(`${input.provider}:${input.accountKey}`)
    .digest("hex");
}

export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function isReloginError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes("refresh token was revoked") ||
    text.includes("refresh_token_invalidated") ||
    text.includes("token_invalidated") ||
    text.includes("authentication token has been invalidated") ||
    text.includes("token_revoked") ||
    text.includes("session invalid") ||
    text.includes("log out and sign in again") ||
    text.includes("not logged in")
  );
}

export function isQuotaLimitedText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("usage limit") ||
    normalized.includes("quota limited") ||
    normalized.includes("quota_limited") ||
    normalized.includes("rate limit")
  );
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown";
  }
}

export function timestampFromUnix(value: unknown): Date | undefined {
  const number = numberValue(value);
  if (number === undefined || number <= 0) return undefined;
  const millis = number > 9_999_999_999 ? number : number * 1000;
  return new Date(millis);
}
