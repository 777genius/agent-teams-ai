export type CodexModelCatalogEntry = {
  readonly model: string;
  readonly displayName?: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly supportedReasoningEfforts: readonly string[];
};

export class CodexModelUnavailableError extends Error {
  readonly code = "codex_model_unavailable" as const;
  readonly requestedModel: string;
  readonly availableModels: readonly CodexModelCatalogEntry[];

  constructor(input: {
    readonly requestedModel: string;
    readonly availableModels: readonly CodexModelCatalogEntry[];
  }) {
    const requestedModel = safeRequestedModel(input.requestedModel);
    const availableModels = normalizeCatalog(input.availableModels);
    const availableSummary = formatAvailableModelIds(availableModels);
    super(
      `Codex model "${requestedModel}" is unavailable for this account. ` +
        `Available models: ${availableSummary}.`,
    );
    this.name = "CodexModelUnavailableError";
    this.requestedModel = requestedModel;
    this.availableModels = availableModels;
  }

  details(): Readonly<Record<string, string>> {
    return {
      requestedModel: this.requestedModel,
      availableModels: this.availableModels.map((entry) => entry.model).join(","),
      availableModelProfiles: this.availableModels
        .map((entry) =>
          entry.supportedReasoningEfforts.length === 0
            ? entry.model
            : `${entry.model}[${entry.supportedReasoningEfforts.join("|")}]`,
        )
        .join(","),
      catalogSource: "codex_app_server_model_list",
    };
  }
}

export function isCodexModelUnavailableError(
  error: unknown,
): error is CodexModelUnavailableError {
  return (
    error instanceof CodexModelUnavailableError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === "codex_model_unavailable" &&
      typeof (error as { readonly details?: unknown }).details === "function" &&
      typeof (error as { readonly message?: unknown }).message === "string")
  );
}

export function isCodexModelUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\bmodel\b.*\bnot supported\b/.test(normalized) ||
    /\bmodel\b.*\bnot available\b/.test(normalized) ||
    /\bunsupported model\b/.test(normalized) ||
    /\bunknown model\b/.test(normalized)
  );
}

export function hasCodexModel(
  catalog: readonly CodexModelCatalogEntry[],
  requestedModel: string,
): boolean {
  return catalog.some((entry) => entry.model === requestedModel);
}

function normalizeCatalog(
  entries: readonly CodexModelCatalogEntry[],
): readonly CodexModelCatalogEntry[] {
  const byModel = new Map<string, CodexModelCatalogEntry>();
  for (const entry of entries) {
    if (!byModel.has(entry.model)) byModel.set(entry.model, entry);
  }
  return [...byModel.values()].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    if (left.hidden !== right.hidden) return left.hidden ? 1 : -1;
    return left.model.localeCompare(right.model);
  });
}

function formatAvailableModelIds(
  entries: readonly CodexModelCatalogEntry[],
): string {
  const visible = entries.slice(0, 20).map((entry) => entry.model);
  const remaining = entries.length - visible.length;
  if (visible.length === 0) return "none reported by Codex";
  return `${visible.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

function safeRequestedModel(value: string): string {
  const normalized = value.trim();
  if (/^[\w.:-]{1,128}$/u.test(normalized)) return normalized;
  return "invalid-model-id";
}
