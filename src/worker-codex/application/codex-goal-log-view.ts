import { DefaultRedactor } from "@vioxen/subscription-runtime/core";

const commandRedactor = new DefaultRedactor();

export function extractRecentCommands(logTail: string): readonly string[] {
  const commands: string[] = [];
  for (const line of logTail.split(/\r?\n/)) {
    const command = commandFromLogLine(line);
    if (!command) continue;
    if (commands.at(-1) !== command) commands.push(command);
  }
  return commands.slice(-10);
}

export function redactLogTail(logTail: string): string {
  return logTail
    .split(/\r?\n/)
    .map((line) => redactCommand(line))
    .join("\n");
}

function commandFromLogLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const promptMatch = /^(?:[$>]|\+\s)(.+)$/.exec(trimmed);
  const command = promptMatch?.[1]?.trim() ?? trimmed;
  if (!/^(?:git|npm|npx|node|pnpm|yarn|bun|uv|python|python3|pytest|ruff|mypy|tsc|vitest|cargo|go|make|cmake|docker|docker-compose|\.venv\/bin\/python|scripts\/)[\s/]/.test(command)) {
    return null;
  }
  return redactCommand(command).slice(0, 500);
}

function redactCommand(command: string): string {
  return commandRedactor.redact(command);
}
