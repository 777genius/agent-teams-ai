import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodexReasoningEffort,
  CodexServiceTier,
} from "../provider-codex/index.js";

export type OpenAiCompatibleCodexBridgeConfig = {
  readonly host: string;
  readonly port: number;
  readonly publicModel: string;
  readonly codexModel: string;
  readonly codexBinaryPath: string;
  readonly authRootDir: string;
  readonly stateDir: string;
  readonly accountNames?: readonly string[];
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly quotaCooldownMs: number;
  readonly maxAccountCycles: number;
  readonly maxConcurrentRequests: number;
  readonly requestBodyMaxBytes: number;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
};

export function loadOpenAiCompatibleCodexBridgeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenAiCompatibleCodexBridgeConfig {
  const codexModel = env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_CODEX_MODEL ?? "gpt-5.5";
  const authRootDir =
    env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_AUTH_ROOT ??
    env.SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT;
  if (!authRootDir?.trim()) {
    throw new Error("openai_bridge_auth_root_required");
  }
  const accountNames = csvEnv(env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_ACCOUNTS);
  return {
    host: env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_HOST ?? "127.0.0.1",
    port: numberEnv(env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_PORT, 8890),
    publicModel:
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_PUBLIC_MODEL ?? codexModel,
    codexModel,
    codexBinaryPath:
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_CODEX_BINARY ?? "codex",
    authRootDir,
    stateDir:
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_STATE_DIR ??
      join(tmpdir(), "subscription-runtime-openai-codex-bridge"),
    ...(accountNames === undefined ? {} : { accountNames }),
    ...(env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_API_KEY
      ? { apiKey: env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_API_KEY }
      : {}),
    timeoutMs: numberEnv(
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_TIMEOUT_MS,
      180_000,
    ),
    quotaCooldownMs: numberEnv(
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_QUOTA_COOLDOWN_MS,
      20 * 60 * 1000,
    ),
    maxAccountCycles: numberEnv(
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_MAX_ACCOUNT_CYCLES,
      1,
    ),
    maxConcurrentRequests: numberEnv(
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_MAX_CONCURRENT,
      1,
    ),
    requestBodyMaxBytes: numberEnv(
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_MAX_BODY_BYTES,
      1024 * 1024,
    ),
    reasoningEffort: reasoningEffortEnv(
      env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_REASONING_EFFORT,
    ),
    ...(env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_SERVICE_TIER
      ? { serviceTier: env.SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_SERVICE_TIER }
      : {}),
  };
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("openai_bridge_invalid_numeric_env");
  }
  return parsed;
}

function csvEnv(value: string | undefined): readonly string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

function reasoningEffortEnv(
  value: string | undefined,
): CodexReasoningEffort {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  if (value === undefined || value.trim() === "") return "low";
  throw new Error("openai_bridge_invalid_reasoning_effort");
}
