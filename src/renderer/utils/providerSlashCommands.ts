import { KNOWN_SLASH_COMMANDS } from '@shared/utils/slashCommands';

import type { TeamProviderId } from '@shared/types';
import type { KnownSlashCommandDefinition } from '@shared/utils/slashCommands';

const CODEX_SLASH_COMMAND_SUGGESTIONS: readonly KnownSlashCommandDefinition[] = [
  {
    name: 'model',
    command: '/model',
    description: 'Choose the active model for this session.',
  },
  {
    name: 'fast',
    command: '/fast',
    description: 'Toggle Fast mode on or off.',
  },
  {
    name: 'permissions',
    command: '/permissions',
    description: 'Adjust approval requirements for tools and commands.',
  },
  {
    name: 'plan',
    command: '/plan',
    description: 'Switch to plan mode with an optional prompt.',
  },
  {
    name: 'review',
    command: '/review',
    description: 'Ask Codex to review the current working tree.',
  },
  {
    name: 'diff',
    command: '/diff',
    description: 'Show the current Git diff, including untracked files.',
  },
  {
    name: 'status',
    command: '/status',
    description: 'Show session configuration and token usage.',
  },
  {
    name: 'mcp',
    command: '/mcp',
    description: 'List configured MCP tools for this session.',
  },
  {
    name: 'mention',
    command: '/mention',
    description: 'Attach a file or folder to the conversation.',
  },
  {
    name: 'apps',
    command: '/apps',
    description: 'Browse available apps and connectors.',
  },
  {
    name: 'plugins',
    command: '/plugins',
    description: 'Browse and manage installed plugins.',
  },
  {
    name: 'agent',
    command: '/agent',
    description: 'Switch to another agent thread.',
  },
  {
    name: 'personality',
    command: '/personality',
    description: 'Change Codex response style for the current thread.',
  },
  {
    name: 'compact',
    command: '/compact',
    description: 'Summarize the conversation to free tokens.',
  },
  {
    name: 'clear',
    command: '/clear',
    description: 'Clear the terminal and start a fresh chat.',
  },
  {
    name: 'new',
    command: '/new',
    description: 'Start a new conversation in the current session.',
  },
  {
    name: 'copy',
    command: '/copy',
    description: 'Copy the latest completed Codex output.',
  },
  {
    name: 'fork',
    command: '/fork',
    description: 'Fork the current conversation into a new thread.',
  },
  {
    name: 'resume',
    command: '/resume',
    description: 'Resume a previous conversation.',
  },
  {
    name: 'quit',
    command: '/quit',
    description: 'Exit the CLI.',
  },
  {
    name: 'exit',
    command: '/exit',
    description: 'Exit the CLI.',
  },
] as const;

export function getSuggestedSlashCommandsForProvider(
  providerId?: TeamProviderId
): readonly KnownSlashCommandDefinition[] {
  if (providerId === 'codex') {
    return CODEX_SLASH_COMMAND_SUGGESTIONS;
  }

  return KNOWN_SLASH_COMMANDS;
}
