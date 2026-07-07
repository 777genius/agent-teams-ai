export enum OpenAiBridgeObjectKind {
  ChatCompletion = "chat.completion",
  Model = "model",
  ModelList = "list",
}

export enum OpenAiBridgeRole {
  System = "system",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
}

export enum OpenAiBridgeFinishReason {
  Stop = "stop",
  Length = "length",
}

export enum OpenAiBridgeErrorCode {
  InvalidRequest = "invalid_request_error",
  Unauthorized = "unauthorized",
  ProviderUnavailable = "provider_unavailable",
  UnsupportedFeature = "unsupported_feature",
}

export enum OpenAiBridgeResponseFormatType {
  JsonObject = "json_object",
  Text = "text",
}

export enum OpenAiBridgeContentPartType {
  Text = "text",
}

export type OpenAiBridgeTextContentPart = {
  readonly type: OpenAiBridgeContentPartType.Text;
  readonly text: string;
};

export type OpenAiBridgeMessage = {
  readonly role: OpenAiBridgeRole;
  readonly content?: string | readonly OpenAiBridgeTextContentPart[] | null;
  readonly name?: string;
};

export type OpenAiBridgeChatCompletionRequest = {
  readonly model?: string;
  readonly messages: readonly OpenAiBridgeMessage[];
  readonly stream?: boolean;
  readonly n?: number;
  readonly response_format?: {
    readonly type?: OpenAiBridgeResponseFormatType;
  };
  readonly tools?: readonly unknown[];
  readonly tool_choice?: unknown;
  readonly temperature?: number;
  readonly max_tokens?: number;
};

export type OpenAiBridgeUsage = {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
};

export type OpenAiBridgeChatCompletionResponse = {
  readonly id: string;
  readonly object: OpenAiBridgeObjectKind.ChatCompletion;
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: {
      readonly role: OpenAiBridgeRole.Assistant;
      readonly content: string;
    };
    readonly finish_reason: OpenAiBridgeFinishReason;
  }[];
  readonly usage: OpenAiBridgeUsage;
  readonly system_fingerprint: string;
};

export type OpenAiBridgeModelListResponse = {
  readonly object: OpenAiBridgeObjectKind.ModelList;
  readonly data: readonly {
    readonly id: string;
    readonly object: OpenAiBridgeObjectKind.Model;
    readonly created: number;
    readonly owned_by: string;
  }[];
};

export type OpenAiBridgeErrorResponse = {
  readonly error: {
    readonly message: string;
    readonly type: OpenAiBridgeErrorCode;
    readonly code: OpenAiBridgeErrorCode;
  };
};

export class OpenAiBridgeRequestError extends Error {
  constructor(
    message: string,
    readonly code: OpenAiBridgeErrorCode,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}
