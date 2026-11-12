import { deliveryFingerprint, runtimeDigest } from '../runtime/identity.js';
import { nativeSessionCommandCause } from './nativeSessionCommandAdmission.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamCommand } from '../team/contracts.js';
import type { MemberEntry } from './MemberEntry.js';

/** Derived local output uses the existing Team message ledger; it never submits another native input. */
export function publishNativeCommandOutput(
  entry: MemberEntry,
  runtime: Pick<RuntimeOwner, 'readCapturedSession' | 'readActivitySnapshot'>
): void {
  if (entry.profile.provider !== 'claude') return;
  const record = runtime.readCapturedSession(entry.binding).record;
  if (!record || runtimeDigest(record.binding) !== runtimeDigest(entry.binding)) return;
  const inputs = record.inputs.filter(
    (input) =>
      input.phase === 'terminal' &&
      (input.terminal === 'succeeded' || input.terminal === 'failed') &&
      input.intent.content.trim().startsWith('/')
  );
  if (!inputs.length) return;
  const activity = runtime.readActivitySnapshot(entry.binding);
  for (const input of inputs) {
    try {
      if (input.fingerprint !== deliveryFingerprint(input.intent)) continue;
      const outputs = activity.latest.text.filter(
        (event) =>
          event.inputId === input.intent.inputId &&
          event.operationRef === input.operationRef &&
          event.data.phase === 'complete' &&
          typeof event.data.messageRef === 'string' &&
          event.data.messageRef.startsWith('local-command:') &&
          typeof event.data.text === 'string' &&
          event.data.text.length > 0 &&
          !event.data.text.includes('\0')
      );
      // Missing, evicted or ambiguous native output is not replaced with a later assistant message.
      if (outputs.length !== 1) continue;
      const cause = nativeSessionCommandCause(entry, input.intent);
      if (!cause) continue;
      const commandId = `native-command-output-${runtimeDigest({ binding: entry.binding, inputId: input.intent.inputId })}`;
      const command: TeamCommand = {
        commandId,
        operation: 'message.send',
        payload: {
          to: 'user',
          messageId: commandId,
          summary: `/${cause.command.name}`,
          text: outputs[0]!.data.text as string,
        },
      };
      const lead = entry.team.owner.connect(entry.profile.principalId);
      const saved = lead.lookup(commandId, command);
      if (saved?.phase === 'completed') continue;
      // Exact lookup validates any partially published original reply before its existing recovery path.
      lead.execute(command);
    } catch {
      /* A held/revoked original reply never prevents another input's output or dispatch. */
    }
  }
}
