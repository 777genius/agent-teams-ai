export interface StandaloneSlashCommand {
  name: string;
  command: `/${string}`;
  args?: string;
  raw: string;
}

export interface StandaloneSlashCommandMeta {
  name: string;
  command: `/${string}`;
  args?: string;
  knownDescription?: string;
}

const STANDALONE_SLASH_COMMAND_PATTERN = /^\/([a-z][a-z0-9:-]{0,63})(?:\s+([\s\S]*\S))?$/i;

const KNOWN_SLASH_COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  compact: 'Compact conversation with optional focus instructions.',
  clear: 'Clear conversation history and free up context.',
  reset: 'Alias of /clear. Clear conversation history and free up context.',
  new: 'Alias of /clear. Start a fresh conversation.',
  plan: 'Enter plan mode with an optional task description.',
  model: 'Select or change the active model.',
  effort: 'Set reasoning effort for the current session.',
  fast: 'Toggle fast mode on or off.',
  cost: 'Show token usage statistics.',
  usage: 'Show plan usage limits and rate-limit status.',
};

export function parseStandaloneSlashCommand(text: string): StandaloneSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = STANDALONE_SLASH_COMMAND_PATTERN.exec(trimmed);
  if (!match) return null;

  const name = match[1].toLowerCase();
  const args = match[2]?.trim();
  return {
    name,
    command: `/${name}`,
    ...(args ? { args } : {}),
    raw: trimmed,
  };
}

export function buildStandaloneSlashCommandMeta(
  command: StandaloneSlashCommand
): StandaloneSlashCommandMeta {
  const knownDescription = KNOWN_SLASH_COMMAND_DESCRIPTIONS[command.name];
  return {
    name: command.name,
    command: command.command,
    ...(command.args ? { args: command.args } : {}),
    ...(knownDescription ? { knownDescription } : {}),
  };
}
