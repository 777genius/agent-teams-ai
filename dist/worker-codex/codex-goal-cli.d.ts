#!/usr/bin/env node
import { type CodexGoalRunConfig } from "./codex-goal-runner.js";
type OutputFormat = "text" | "json";
type CodexGoalCliCommand = RunCommand | StatusCommand | DoctorCommand | TailCommand | McpToolsCommand | McpToolCommand | McpResourcesCommand | McpResourceCommand | McpPromptsCommand | McpPromptCommand | ControlDoctorCommand | HelpCommand;
type RunCommand = {
    readonly kind: "run";
    readonly config: CodexGoalRunConfig;
    readonly tmuxSession?: string;
    readonly dryRun: boolean;
    readonly printCommand: boolean;
    readonly format: OutputFormat;
    readonly cwd: string;
    readonly logPath: string;
};
type StatusCommand = {
    readonly kind: "status";
    readonly jobRootDir?: string;
    readonly taskId?: string;
    readonly workspacePath?: string;
    readonly tmuxSession?: string;
    readonly progressPath?: string;
    readonly format: OutputFormat;
};
type DoctorCommand = {
    readonly kind: "doctor";
    readonly config: CodexGoalRunConfig;
    readonly tmuxSession?: string;
    readonly format: OutputFormat;
};
type TailCommand = {
    readonly kind: "tail";
    readonly logPath: string;
    readonly lines: number;
};
type McpToolsCommand = {
    readonly kind: "mcp-tools";
    readonly format: OutputFormat;
};
type McpToolCommand = {
    readonly kind: "mcp-tool";
    readonly name: string;
    readonly argsJson?: string;
    readonly argsFile?: string;
    readonly format: OutputFormat;
};
type McpResourcesCommand = {
    readonly kind: "mcp-resources";
    readonly format: OutputFormat;
};
type McpResourceCommand = {
    readonly kind: "mcp-resource";
    readonly uri: string;
    readonly format: OutputFormat;
};
type McpPromptsCommand = {
    readonly kind: "mcp-prompts";
    readonly format: OutputFormat;
};
type McpPromptCommand = {
    readonly kind: "mcp-prompt";
    readonly name: string;
    readonly argsJson?: string;
    readonly argsFile?: string;
    readonly format: OutputFormat;
};
type ControlDoctorCommand = {
    readonly kind: "control-doctor";
    readonly format: OutputFormat;
};
type HelpCommand = {
    readonly kind: "help";
};
export type CodexGoalCliIo = {
    writeStdout(chunk: string): void;
    writeStderr(chunk: string): void;
    cwd(): string;
    env(): Readonly<Record<string, string | undefined>>;
};
export declare function runCodexGoalCli(argv?: string[], io?: CodexGoalCliIo): Promise<number>;
export declare function parseCodexGoalCliArgs(argv: readonly string[], io?: CodexGoalCliIo): CodexGoalCliCommand;
export declare function buildTmuxCommand(command: RunCommand): {
    readonly args: readonly string[];
    readonly preview: string;
};
export declare function buildNoTmuxShellCommand(command: RunCommand): string;
export {};
//# sourceMappingURL=codex-goal-cli.d.ts.map