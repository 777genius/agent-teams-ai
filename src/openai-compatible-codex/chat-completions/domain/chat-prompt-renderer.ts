import {
  OpenAiBridgeContentPartType,
  OpenAiBridgeErrorCode,
  OpenAiBridgeRequestError,
  OpenAiBridgeResponseFormatType,
  OpenAiBridgeRole,
  type OpenAiBridgeChatCompletionRequest,
  type OpenAiBridgeMessage,
} from "./openai-chat-contracts.js";

export type RenderedOpenAiBridgeChat = {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly promptTextForUsageEstimate: string;
};

export function renderOpenAiBridgeChat(
  request: OpenAiBridgeChatCompletionRequest,
): RenderedOpenAiBridgeChat {
  const systemMessages: string[] = [];
  const transcript: string[] = [];

  for (const message of request.messages) {
    const content = messageContentToText(message);
    if (!content.trim()) continue;
    if (message.role === OpenAiBridgeRole.System) {
      systemMessages.push(content);
      continue;
    }
    transcript.push(renderTranscriptMessage(message, content));
  }

  const jsonInstruction =
    request.response_format?.type === OpenAiBridgeResponseFormatType.JsonObject
      ? "Return one valid JSON object only. Do not wrap it in markdown fences."
      : null;

  const systemPrompt = [
    "You are serving an OpenAI-compatible chat/completions request through subscription-runtime.",
    "Answer as the assistant. Do not mention this bridge.",
    ...systemMessages,
    ...(jsonInstruction ? [jsonInstruction] : []),
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");

  const prompt = [
    "Conversation transcript follows. Continue with the final assistant response only.",
    "",
    transcript.join("\n\n"),
  ].join("\n");

  return {
    prompt,
    ...(systemPrompt ? { systemPrompt } : {}),
    promptTextForUsageEstimate: `${systemPrompt}\n${prompt}`,
  };
}

function renderTranscriptMessage(
  message: OpenAiBridgeMessage,
  content: string,
): string {
  const name = message.name?.trim();
  return [
    `<message role="${message.role}"${name ? ` name="${escapeXmlAttribute(name)}"` : ""}>`,
    content,
    "</message>",
  ].join("\n");
}

function messageContentToText(message: OpenAiBridgeMessage): string {
  const content = message.content;
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new OpenAiBridgeRequestError(
      "Only string and text-part message content are supported.",
      OpenAiBridgeErrorCode.UnsupportedFeature,
      400,
    );
  }
  return content.map((part) => {
    if (
      !part ||
      part.type !== OpenAiBridgeContentPartType.Text ||
      typeof part.text !== "string"
    ) {
      throw new OpenAiBridgeRequestError(
        "Only text content parts are supported.",
        OpenAiBridgeErrorCode.UnsupportedFeature,
        400,
      );
    }
    return part.text;
  }).join("");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
