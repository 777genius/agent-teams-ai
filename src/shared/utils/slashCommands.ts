import type { SlashCommandMeta } from '@shared/types/team';

export interface KnownSlashCommandDefinition {
  name: string;
  command: `/${string}`;
  description: string;
}

export interface ParsedStandaloneSlashCommand {
  name: string;
  command: `/${string}`;
  args?: string;
  raw: string;
  startIndex: number;
  endIndex: number;
}

const STANDALONE_SLASH_COMMAND_PATTERN = /^\/([a-z][a-z0-9:-]{0,63})(?:\s+([\s\S]*\S))?$/i;

export const KNOWN_SLASH_COMMANDS: readonly KnownSlashCommandDefinition[] = [
  {
    name: 'compact',
    command: '/compact',
    description: 'Compact conversation with optional focus instructions.',
  },
  {
    name: 'clear',
    command: '/clear',
    description: 'Clear conversation history and free up context.',
  },
  {
    name: 'reset',
    command: '/reset',
    description: 'Alias of /clear. Clear conversation history and free up context.',
  },
  {
    name: 'new',
    command: '/new',
    description: 'Alias of /clear. Start a fresh conversation.',
  },
  {
    name: 'plan',
    command: '/plan',
    description: 'Enter plan mode with an optional task description.',
  },
  {
    name: 'model',
    command: '/model',
    description: 'Select or change the Claude model.',
  },
  {
    name: 'effort',
    command: '/effort',
    description: 'Set reasoning effort for the current session.',
  },
  {
    name: 'fast',
    command: '/fast',
    description: 'Toggle fast mode on or off.',
  },
  {
    name: 'cost',
    command: '/cost',
    description: 'Show token usage statistics.',
  },
  {
    name: 'usage',
    command: '/usage',
    description: 'Show plan usage limits and rate-limit status.',
  },
] as const;

const KNOWN_SLASH_COMMANDS_BY_NAME = new Map(
  KNOWN_SLASH_COMMANDS.map((command) => [command.name.toLowerCase(), command] as const)
);

export function getKnownSlashCommand(name: string): KnownSlashCommandDefinition | null {
  return KNOWN_SLASH_COMMANDS_BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

export function buildSlashCommandMeta(
  name: string,
  args?: string,
  command?: `/${string}`
): SlashCommandMeta {
  const normalizedName = name.trim().toLowerCase();
  const normalizedCommand = command ?? `/${normalizedName}`;
  const known = getKnownSlashCommand(normalizedName);
  return {
    name: normalizedName,
    command: normalizedCommand,
    ...(args ? { args } : {}),
    ...(known ? { knownDescription: known.description } : {}),
  };
}

export function buildStandaloneSlashCommandMeta(text: string): SlashCommandMeta | null {
  const parsed = parseStandaloneSlashCommand(text);
  if (!parsed) return null;
  return buildSlashCommandMeta(parsed.name, parsed.args, parsed.command);
}

export function parseStandaloneSlashCommand(text: string): ParsedStandaloneSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = STANDALONE_SLASH_COMMAND_PATTERN.exec(trimmed);
  if (!match) return null;

  const name = match[1].toLowerCase();
  const args = match[2]?.trim();
  const startIndex = text.indexOf(trimmed);
  const endIndex = startIndex + trimmed.length;

  return {
    name,
    command: `/${name}`,
    args: args || undefined,
    raw: trimmed,
    startIndex,
    endIndex,
  };
}
