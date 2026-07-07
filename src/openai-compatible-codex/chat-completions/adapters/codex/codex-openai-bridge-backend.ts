import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DefaultRedactor } from "../../../../core/index.js";
import {
  PackagedCodexJsonExecutionEngine,
  classifyCodexRuntimeFailure,
  type CodexMaterializedSession,
  type CodexReasoningEffort,
  type CodexServiceTier,
} from "../../../../provider-codex/index.js";
import { NodeProcessRunner } from "../../../../worker-local/index.js";
import {
  OpenAiBridgeErrorCode,
  OpenAiBridgeRequestError,
} from "../../domain/openai-chat-contracts.js";
import type {
  OpenAiBridgeChatBackend,
  OpenAiBridgeChatBackendInput,
  OpenAiBridgeChatBackendResult,
} from "../../ports/chat-backend-port.js";
import {
  discoverCodexBridgeAccounts,
  seedIsolatedBridgeAccount,
  type CodexOpenAiBridgeAccount,
  type IsolatedCodexOpenAiBridgeAccount,
} from "./codex-account-isolation.js";

export { discoverCodexBridgeAccounts, type CodexOpenAiBridgeAccount };

export type CodexOpenAiBridgeBackendOptions = {
  readonly codexBinaryPath: string;
  readonly authRootDir: string;
  readonly stateDir: string;
  readonly accountNames?: readonly string[];
  readonly timeoutMs: number;
  readonly quotaCooldownMs: number;
  readonly maxAccountCycles: number;
  readonly maxConcurrentRequests: number;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

type AccountState = CodexOpenAiBridgeAccount &
  IsolatedCodexOpenAiBridgeAccount & {
    cooldownUntilMs: number;
  };

export class CodexOpenAiBridgeBackend implements OpenAiBridgeChatBackend {
  private readonly runner = new NodeProcessRunner();
  private readonly redactor = new DefaultRedactor();
  private readonly engine: PackagedCodexJsonExecutionEngine;
  private readonly ready: Promise<void>;
  private accounts: AccountState[] = [];
  private nextAccountIndex = 0;
  private activeRequests = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly options: CodexOpenAiBridgeBackendOptions) {
    this.engine = new PackagedCodexJsonExecutionEngine({
      codexBinaryPath: options.codexBinaryPath,
      timeoutMs: options.timeoutMs,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
    });
    this.ready = this.loadAccounts();
  }

  async complete(
    input: OpenAiBridgeChatBackendInput,
  ): Promise<OpenAiBridgeChatBackendResult> {
    await this.ready;
    await this.acquireRequestSlot(input.abortSignal);
    try {
      return await this.runWithAccounts(input);
    } finally {
      this.releaseRequestSlot();
    }
  }

  health(): {
    readonly accountCount: number;
    readonly activeRequests: number;
    readonly queuedRequests: number;
  } {
    return {
      accountCount: this.accounts.length,
      activeRequests: this.activeRequests,
      queuedRequests: this.waiters.length,
    };
  }

  private async loadAccounts(): Promise<void> {
    const discovered = await discoverCodexBridgeAccounts({
      authRootDir: this.options.authRootDir,
      ...(this.options.accountNames === undefined
        ? {}
        : { accountNames: this.options.accountNames }),
    });
    if (discovered.length === 0) {
      throw new OpenAiBridgeRequestError(
        "No Codex accounts are available for the OpenAI-compatible bridge.",
        OpenAiBridgeErrorCode.ProviderUnavailable,
        503,
      );
    }
    await mkdir(join(this.options.stateDir, "workspace"), {
      recursive: true,
      mode: 0o700,
    });
    this.accounts = await Promise.all(
      discovered.map(async (account) => ({
        ...account,
        ...(await seedIsolatedBridgeAccount({
          stateDir: this.options.stateDir,
          account,
        })),
        cooldownUntilMs: 0,
      })),
    );
  }

  private async runWithAccounts(
    input: OpenAiBridgeChatBackendInput,
  ): Promise<OpenAiBridgeChatBackendResult> {
    const maxAttempts = Math.max(
      1,
      this.accounts.length * Math.max(1, this.options.maxAccountCycles),
    );
    let lastFailure: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const account = this.nextAvailableAccount();
      if (!account) break;
      try {
        const result = await this.engine.run({
          runId: input.requestId,
          prompt: input.prompt,
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          session: this.materializedSessionFor(account),
          workspacePath: join(this.options.stateDir, "workspace"),
          runner: this.runner,
          redactor: this.redactor,
          model: input.model,
          reasoningEffort: this.options.reasoningEffort,
          ...(this.options.serviceTier === undefined
            ? {}
            : { serviceTier: this.options.serviceTier }),
          sandboxMode: "read-only",
          abortSignal: input.abortSignal,
        });
        return { text: result.outputText, model: input.model };
      } catch (error) {
        lastFailure = error;
        if (!this.shouldRetryWithNextAccount(error)) {
          throw toBridgeProviderError(error);
        }
        account.cooldownUntilMs = Date.now() + this.options.quotaCooldownMs;
      }
    }
    throw toBridgeProviderError(lastFailure);
  }

  private materializedSessionFor(
    account: AccountState,
  ): CodexMaterializedSession {
    return {
      home: account.home,
      codexHome: account.codexHome,
      env: {
        HOME: account.home,
        CODEX_HOME: account.codexHome,
      },
      release: async () => {},
    };
  }

  private nextAvailableAccount(): AccountState | null {
    const now = Date.now();
    for (let offset = 0; offset < this.accounts.length; offset += 1) {
      const index = (this.nextAccountIndex + offset) % this.accounts.length;
      const account = this.accounts[index];
      if (!account || account.cooldownUntilMs > now) continue;
      this.nextAccountIndex = (index + 1) % this.accounts.length;
      return account;
    }
    return null;
  }

  private shouldRetryWithNextAccount(error: unknown): boolean {
    const code = classifyCodexRuntimeFailure(errorMessage(error));
    return (
      code === "quota_limited" ||
      code === "needs_reconnect" ||
      code === "provider_session_invalid" ||
      code === "permission_required"
    );
  }

  private async acquireRequestSlot(abortSignal: AbortSignal): Promise<void> {
    if (this.activeRequests < this.options.maxConcurrentRequests) {
      this.activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        cleanup();
        this.activeRequests += 1;
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("openai_bridge_request_aborted"));
      };
      const cleanup = () => {
        abortSignal.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      this.waiters.push(waiter);
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaseRequestSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

function toBridgeProviderError(error: unknown): OpenAiBridgeRequestError {
  const code = classifyCodexRuntimeFailure(errorMessage(error));
  const httpStatus = code === "quota_limited" ? 429 : 503;
  return new OpenAiBridgeRequestError(
    `Codex bridge provider failed: ${code}`,
    OpenAiBridgeErrorCode.ProviderUnavailable,
    httpStatus,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
