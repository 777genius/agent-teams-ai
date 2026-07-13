import type { CodexModelCatalogEntry } from "../domain/model-catalog";
import { readRecord } from "./app-server-content-parser";

export type CodexModelCatalogPage = {
  readonly data: readonly CodexModelCatalogEntry[];
  readonly nextCursor: string | null;
};

export function readCodexModelCatalogPage(
  result: Record<string, unknown> | undefined,
): CodexModelCatalogPage | null {
  const data = result?.data;
  if (!Array.isArray(data)) return null;

  const entries: CodexModelCatalogEntry[] = [];
  for (const value of data) {
    const entry = readCodexModelCatalogEntry(value);
    if (entry) entries.push(entry);
  }
  if (data.length > 0 && entries.length === 0) return null;

  const nextCursor = result?.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length > 512)
  ) {
    return null;
  }
  return {
    data: entries,
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
  };
}

function readCodexModelCatalogEntry(
  value: unknown,
): CodexModelCatalogEntry | null {
  const record = readRecord(value);
  const model = safeModelId(record?.model);
  if (!model) return null;

  const efforts = Array.isArray(record?.supportedReasoningEfforts)
    ? record.supportedReasoningEfforts
        .map((effort) =>
          safeCatalogString(readRecord(effort)?.reasoningEffort, 32),
        )
        .filter((effort): effort is string => effort !== null)
    : [];

  const displayName = safeCatalogString(record?.displayName, 160);
  return {
    model,
    ...(displayName === null ? {} : { displayName }),
    hidden: record?.hidden === true,
    isDefault: record?.isDefault === true,
    supportedReasoningEfforts: [...new Set(efforts)],
  };
}

function safeCatalogString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  if (!/^[\w .:+/()\-]+$/u.test(normalized)) return null;
  return normalized;
}

function safeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[\w.:-]{1,128}$/u.test(normalized) ? normalized : null;
}
