import type { CodexSandboxMode } from "./codex-json-execution-engine";

export type CodexAppServerNativeToolSurface = "default" | "disabled";

export type CodexAppServerCommandApprovalInput = {
  readonly source:
    | "command_execution"
    | "legacy_exec"
    | "thread_shell_command";
  readonly command?: readonly string[];
  readonly commandText?: string;
  readonly cwd?: string;
};

export type CodexAppServerCommandApprovalDecision = {
  readonly approved: boolean;
  readonly reason?: string;
};

export type CodexAppServerCommandApprovalPolicy = {
  readonly reviewCommand: (
    input: CodexAppServerCommandApprovalInput,
  ) => CodexAppServerCommandApprovalDecision;
};

export type CodexAppServerSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly"; readonly networkAccess: false }
  | {
      readonly type: "workspaceWrite";
      readonly writableRoots: readonly string[];
      readonly networkAccess: false;
      readonly excludeSlashTmp: true;
      readonly excludeTmpdirEnvVar: true;
    };

export type CodexAppServerThreadRuntimePolicy = {
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly sandboxMode: CodexSandboxMode;
  readonly developerInstructions: string | null;
};

export function normalizeSystemPrompt(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function uniqueNonEmptyStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function codexExtraWritableRootsFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): readonly string[] {
  if (sourceEnv?.SUBSCRIPTION_RUNTIME_CODEX_SUPPRESS_EXTRA_WRITABLE_ROOTS === "1") {
    return [];
  }
  const raw = sourceEnv?.SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS;
  if (!raw) return [];
  return uniqueNonEmptyStrings(raw.split(/[,\n:]/u));
}

export function mergeDeveloperInstructions(input: {
  readonly base: string | null;
  readonly systemPrompt?: string | undefined;
}): string | null {
  const systemPrompt = normalizeSystemPrompt(input.systemPrompt);
  if (!systemPrompt) return input.base;
  if (!input.base) return systemPrompt;
  return `${input.base}\n\n${systemPrompt}`;
}

export function codexAppServerThreadRuntimePolicy(input: {
  readonly workspacePath: string;
  readonly sandboxMode?: CodexSandboxMode;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly baseDeveloperInstructions: string | null;
  readonly systemPrompt?: string | undefined;
}): CodexAppServerThreadRuntimePolicy {
  return {
    runtimeWorkspaceRoots: uniqueNonEmptyStrings([
      input.workspacePath,
      ...codexExtraWritableRootsFromEnv(input.sourceEnv),
    ]),
    sandboxMode: input.sandboxMode ?? "read-only",
    developerInstructions: mergeDeveloperInstructions({
      base: input.baseDeveloperInstructions,
      systemPrompt: input.systemPrompt,
    }),
  };
}

export function codexAppServerSandboxPolicy(input: {
  readonly sandboxMode?: CodexSandboxMode;
  readonly workspacePath: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
}): CodexAppServerSandboxPolicy {
  const sandboxMode = input.sandboxMode ?? "read-only";
  if (sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (sandboxMode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: uniqueNonEmptyStrings([
        input.workspacePath,
        ...codexExtraWritableRootsFromEnv(input.sourceEnv),
      ]),
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    };
  }
  return { type: "readOnly", networkAccess: false };
}
