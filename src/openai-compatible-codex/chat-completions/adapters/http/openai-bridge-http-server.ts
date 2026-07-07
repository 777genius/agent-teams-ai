import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { OpenAiBridgeChatCompletionUseCase } from "../../application/chat-completion-use-case.js";
import {
  OpenAiBridgeErrorCode,
  OpenAiBridgeObjectKind,
  OpenAiBridgeRequestError,
  type OpenAiBridgeErrorResponse,
  type OpenAiBridgeModelListResponse,
} from "../../domain/openai-chat-contracts.js";

export type OpenAiBridgeHttpServerOptions = {
  readonly host: string;
  readonly port: number;
  readonly apiKey?: string;
  readonly publicModel: string;
  readonly requestBodyMaxBytes: number;
  readonly chatCompletion: OpenAiBridgeChatCompletionUseCase;
  readonly health: () => unknown;
};

export async function startOpenAiBridgeHttpServer(
  options: OpenAiBridgeHttpServerOptions,
): Promise<Server> {
  const server = createServer((request, response) => {
    void handleRequest(options, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleRequest(
  options: OpenAiBridgeHttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, {
        ok: true,
        service: "subscription-runtime-openai-compatible-codex",
        model: options.publicModel,
        ...asRecord(options.health()),
      });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      writeJson(response, 200, modelsResponse(options.publicModel));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      assertAuthorized(options, request);
      const body = await readJsonBody(request, options.requestBodyMaxBytes);
      const abortController = new AbortController();
      request.once("aborted", () => abortController.abort());
      const result = await options.chatCompletion.complete({
        request: body,
        abortSignal: abortController.signal,
      });
      writeJson(response, 200, result);
      return;
    }
    writeJson(
      response,
      404,
      errorResponse("Route not found.", OpenAiBridgeErrorCode.InvalidRequest),
    );
  } catch (error) {
    const bridgeError =
      error instanceof OpenAiBridgeRequestError
        ? error
        : new OpenAiBridgeRequestError(
            "OpenAI-compatible bridge request failed.",
            OpenAiBridgeErrorCode.ProviderUnavailable,
            500,
          );
    process.stderr.write(`${JSON.stringify({
      event: "openai_bridge_request_failed",
      code: bridgeError.code,
      httpStatus: bridgeError.httpStatus,
    })}\n`);
    writeJson(
      response,
      bridgeError.httpStatus,
      errorResponse(bridgeError.message, bridgeError.code),
    );
  }
}

function assertAuthorized(
  options: OpenAiBridgeHttpServerOptions,
  request: IncomingMessage,
): void {
  if (!options.apiKey) return;
  const header = request.headers.authorization;
  if (header !== `Bearer ${options.apiKey}`) {
    throw new OpenAiBridgeRequestError(
      "Unauthorized.",
      OpenAiBridgeErrorCode.Unauthorized,
      401,
    );
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new OpenAiBridgeRequestError(
        "Request body is too large.",
        OpenAiBridgeErrorCode.InvalidRequest,
        413,
      );
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new OpenAiBridgeRequestError(
      "Request body must be valid JSON.",
      OpenAiBridgeErrorCode.InvalidRequest,
      400,
    );
  }
}

function modelsResponse(model: string): OpenAiBridgeModelListResponse {
  return {
    object: OpenAiBridgeObjectKind.ModelList,
    data: [
      {
        id: model,
        object: OpenAiBridgeObjectKind.Model,
        created: 0,
        owned_by: "subscription-runtime",
      },
    ],
  };
}

function errorResponse(
  message: string,
  code: OpenAiBridgeErrorCode,
): OpenAiBridgeErrorResponse {
  return {
    error: {
      message,
      type: code,
      code,
    },
  };
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}
