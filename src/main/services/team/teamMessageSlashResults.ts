import { buildStandaloneSlashCommandMeta } from '@shared/utils/slashCommands';

import type { InboxMessage } from '@shared/types';

function isLeadThoughtCandidateForSlashResult(message: InboxMessage): boolean {
  if (typeof message.to === 'string' && message.to.trim().length > 0) return false;
  if (message.from === 'system') return false;
  return message.source === 'lead_session' || message.source === 'lead_process';
}

export function annotateSlashCommandResponses(messages: InboxMessage[]): void {
  let pendingSlash = null as InboxMessage['slashCommand'] | null;

  for (const message of messages) {
    const slashCommand =
      message.source === 'user_sent'
        ? (message.slashCommand ?? buildStandaloneSlashCommandMeta(message.text))
        : null;

    if (slashCommand) {
      pendingSlash = slashCommand;
      continue;
    }

    if (!pendingSlash) {
      continue;
    }

    if (message.messageKind === 'slash_command_result') {
      continue;
    }

    if (isLeadThoughtCandidateForSlashResult(message)) {
      message.messageKind = 'slash_command_result';
      message.commandOutput = {
        stream: 'stdout',
        commandLabel: pendingSlash.command,
      };
      continue;
    }

    pendingSlash = null;
  }
}

