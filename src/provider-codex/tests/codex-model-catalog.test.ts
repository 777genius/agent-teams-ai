import { describe, expect, it } from "vitest";
import {
  CodexModelUnavailableError,
  isCodexModelUnavailableMessage,
} from "../app-server/domain/model-catalog";
import { readCodexModelCatalogPage } from "../app-server/protocol/app-server-model-catalog";

describe("Codex model catalog", () => {
  it("parses model ids and provider-advertised reasoning efforts", () => {
    expect(
      readCodexModelCatalogPage({
        data: [
          {
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "high" },
              { reasoningEffort: "xhigh" },
            ],
          },
        ],
        nextCursor: null,
      }),
    ).toEqual({
      data: [
        {
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: ["high", "xhigh"],
        },
      ],
      nextCursor: null,
    });
  });

  it("rejects malformed catalog payloads instead of trusting provider text", () => {
    expect(readCodexModelCatalogPage({ data: "not-an-array" })).toBeNull();
    expect(
      readCodexModelCatalogPage({
        data: [{ model: "gpt-5.6-sol\nunsafe" }],
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("builds bounded safe diagnostics with available model profiles", () => {
    const error = new CodexModelUnavailableError({
      requestedModel: "gpt-5.6",
      availableModels: [
        {
          model: "gpt-5.6-sol",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: ["high", "xhigh"],
        },
        {
          model: "gpt-5.5",
          hidden: false,
          isDefault: false,
          supportedReasoningEfforts: ["medium", "high"],
        },
      ],
    });

    expect(error.message).toContain("gpt-5.6-sol");
    expect(error.details()).toMatchObject({
      requestedModel: "gpt-5.6",
      availableModels: "gpt-5.6-sol,gpt-5.5",
      availableModelProfiles: "gpt-5.6-sol[high|xhigh],gpt-5.5[medium|high]",
      catalogSource: "codex_app_server_model_list",
    });
  });

  it("recognizes provider model-availability errors without broad matching", () => {
    expect(
      isCodexModelUnavailableMessage(
        "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account",
      ),
    ).toBe(true);
    expect(isCodexModelUnavailableMessage("Codex backend unavailable")).toBe(false);
  });
});
