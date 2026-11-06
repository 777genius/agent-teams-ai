import { readProductCommand } from './commandEntries.js';
import { lookupEvidenceCause } from './lookupEvidenceCause.js';

/** Ordinary nested execution inherits only the current original-input DO policy in a solo Team. */
export function ordinarySubagentAllowed(options: Parameters<typeof lookupEvidenceCause>[0] & { memberCount: number }): boolean {
  if (options.memberCount !== 1) return false;
  const cause = lookupEvidenceCause(options);
  if (!cause) return false;
  if ('taskId' in cause) return true; // A canonical Task start is an accepted DO action.
  const receipt = readProductCommand(options.store, cause.messageCommandId);
  return receipt?.command.operation === 'message.send' && (receipt.command.payload.actionMode ?? 'do') === 'do';
}
