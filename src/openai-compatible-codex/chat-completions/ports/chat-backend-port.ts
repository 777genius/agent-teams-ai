export type OpenAiBridgeChatBackendInput = {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model: string;
  readonly requestId: string;
  readonly abortSignal: AbortSignal;
};

export type OpenAiBridgeChatBackendResult = {
  readonly text: string;
  readonly model: string;
};

export interface OpenAiBridgeChatBackend {
  complete(
    input: OpenAiBridgeChatBackendInput,
  ): Promise<OpenAiBridgeChatBackendResult>;
}
