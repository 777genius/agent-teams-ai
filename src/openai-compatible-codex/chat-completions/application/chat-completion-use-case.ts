import { randomUUID } from "node:crypto";
import { renderOpenAiBridgeChat } from "../domain/chat-prompt-renderer.js";
import {
  OpenAiBridgeFinishReason,
  OpenAiBridgeObjectKind,
  OpenAiBridgeRole,
  type OpenAiBridgeChatCompletionResponse,
  type OpenAiBridgeUsage,
} from "../domain/openai-chat-contracts.js";
import type { OpenAiBridgeChatBackend } from "../ports/chat-backend-port.js";
import { parseChatCompletionRequest } from "./parse-chat-completion-request.js";

export type OpenAiBridgeChatCompletionUseCaseOptions = {
  readonly backend: OpenAiBridgeChatBackend;
  readonly publicModel: string;
  readonly codexModel: string;
  readonly clock?: () => Date;
};

export class OpenAiBridgeChatCompletionUseCase {
  private readonly now: () => Date;

  constructor(private readonly options: OpenAiBridgeChatCompletionUseCaseOptions) {
    this.now = options.clock ?? (() => new Date());
  }

  async complete(input: {
    readonly request: unknown;
    readonly abortSignal: AbortSignal;
  }): Promise<OpenAiBridgeChatCompletionResponse> {
    const request = parseChatCompletionRequest(input.request);
    const rendered = renderOpenAiBridgeChat(request);
    const backendResult = await this.options.backend.complete({
      prompt: rendered.prompt,
      ...(rendered.systemPrompt ? { systemPrompt: rendered.systemPrompt } : {}),
      model: this.options.codexModel,
      requestId: randomUUID(),
      abortSignal: input.abortSignal,
    });
    const usage = estimateUsage({
      prompt: rendered.promptTextForUsageEstimate,
      completion: backendResult.text,
    });
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: OpenAiBridgeObjectKind.ChatCompletion,
      created: Math.floor(this.now().getTime() / 1000),
      model: request.model ?? this.options.publicModel,
      choices: [
        {
          index: 0,
          message: {
            role: OpenAiBridgeRole.Assistant,
            content: backendResult.text,
          },
          finish_reason: OpenAiBridgeFinishReason.Stop,
        },
      ],
      usage,
      system_fingerprint: "subscription-runtime-codex-bridge-v1",
    };
  }
}

function estimateUsage(input: {
  readonly prompt: string;
  readonly completion: string;
}): OpenAiBridgeUsage {
  const promptTokens = estimateTokens(input.prompt);
  const completionTokens = estimateTokens(input.completion);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function estimateTokens(value: string): number {
  const compact = value.trim();
  if (!compact) return 0;
  return Math.max(1, Math.ceil(compact.length / 4));
}
