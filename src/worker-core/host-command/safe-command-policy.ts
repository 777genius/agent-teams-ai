export type CommandPolicy = {
  readonly validateCommands: boolean;
  readonly deniedExecutableNames: readonly string[];
  readonly deniedGitSubcommands: readonly string[];
  readonly deniedPathPrefixes: readonly string[];
  readonly deniedInlineCodeExecutables: readonly string[];
  readonly deniedScriptExecutables: readonly string[];
};

export enum CommandValidationDecisionReason {
  Allowed = "allowed",
  ValidationDisabled = "validation_disabled",
  EmptyCommand = "empty_command",
  DeniedExecutable = "denied_executable",
  DeniedGitSubcommand = "denied_git_subcommand",
  DeniedPathPrefix = "denied_path_prefix",
  InlineCodeDenied = "inline_code_denied",
  ScriptInterpreterDenied = "script_interpreter_denied",
}

export type CommandValidationDecision = {
  readonly allowed: boolean;
  readonly reason: CommandValidationDecisionReason;
  readonly executableName?: string;
  readonly evidence: readonly string[];
};

export function validateCommandAgainstPolicy(input: {
  readonly command: readonly string[] | string;
  readonly policy: CommandPolicy;
}): CommandValidationDecision {
  if (!input.policy.validateCommands) {
    return commandAllowed(CommandValidationDecisionReason.ValidationDisabled);
  }
  const args = typeof input.command === "string"
    ? simpleCommandTokens(input.command)
    : input.command;
  if (args.length === 0 || !args[0]?.trim()) {
    return commandDenied(CommandValidationDecisionReason.EmptyCommand);
  }
  const executableName = executableBaseName(args[0] as string);
  if (input.policy.deniedExecutableNames.includes(executableName)) {
    return commandDenied(CommandValidationDecisionReason.DeniedExecutable, {
      executableName,
      evidence: [`${executableName} is denied by command policy`],
    });
  }
  if (
    executableName === "git" &&
    input.policy.deniedGitSubcommands.includes(args[1] ?? "")
  ) {
    return commandDenied(CommandValidationDecisionReason.DeniedGitSubcommand, {
      executableName,
      evidence: [`git ${args[1] ?? ""} is denied by command policy`],
    });
  }
  if (
    input.policy.deniedInlineCodeExecutables.includes(executableName) &&
    (args[1] === "-c" || args[1] === "-e")
  ) {
    return commandDenied(CommandValidationDecisionReason.InlineCodeDenied, {
      executableName,
      evidence: [`${executableName} inline code execution is denied`],
    });
  }
  if (
    input.policy.deniedScriptExecutables.includes(executableName) &&
    args.length > 1
  ) {
    return commandDenied(CommandValidationDecisionReason.ScriptInterpreterDenied, {
      executableName,
      evidence: [`${executableName} script execution is denied`],
    });
  }
  const commandText = args.join(" ");
  const deniedPath = input.policy.deniedPathPrefixes.find((prefix) =>
    commandText.includes(prefix)
  );
  if (deniedPath) {
    return commandDenied(CommandValidationDecisionReason.DeniedPathPrefix, {
      executableName,
      evidence: [`command references denied path prefix ${deniedPath}`],
    });
  }
  return commandAllowed(CommandValidationDecisionReason.Allowed, executableName);
}

function commandAllowed(
  reason: CommandValidationDecisionReason,
  executableName?: string,
): CommandValidationDecision {
  return {
    allowed: true,
    reason,
    ...(executableName ? { executableName } : {}),
    evidence: [],
  };
}

function commandDenied(
  reason: CommandValidationDecisionReason,
  options: {
    readonly executableName?: string;
    readonly evidence?: readonly string[];
  } = {},
): CommandValidationDecision {
  return {
    allowed: false,
    reason,
    ...(options.executableName ? { executableName: options.executableName } : {}),
    evidence: options.evidence ?? [],
  };
}

function executableBaseName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? value;
}

function simpleCommandTokens(command: string): readonly string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}
