import { TeamOwnerError } from './contracts.js';
import { digest, effectId } from './identity.js';
import { nativeMemberCreationSchema } from './nativeMemberCreationContracts.js';
import type { OwnerState } from './ownerState.js';

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Original roster records are never silently ignored as an unknown receipt family. */
export function validateNativeMemberCreationRecords(state: OwnerState): void {
  for (const receipt of state.rosterCommands ?? []) {
    const row = receipt.nativeCreation;
    if (row === undefined) continue;
    const parsed = nativeMemberCreationSchema.safeParse(row.input);
    if (
      !parsed.success ||
      row.schemaVersion !== 1 ||
      !['prepared', 'configured', 'completed', 'held'].includes(row.phase) ||
      !hash(row.inputAuthority) ||
      row.expectedRosterRevision !== parsed.data.expectedRosterRevision ||
      receipt.commandId !== parsed.data.commandId ||
      !row.source ||
      row.source.role !== 'lead' ||
      row.source.mode !== 'do' ||
      row.source.principalId !== receipt.principalId ||
      !hash(row.source.fingerprint) ||
      !Number.isSafeInteger(row.source.authorityRevision) ||
      row.source.authorityRevision < 1 ||
      !row.source.source ||
      row.source.source.backendId !== state.binding.backendId ||
      row.source.source.teamId !== state.binding.teamId ||
      !Object.values(row.source.source).every(text) ||
      !text(row.source.actorId) ||
      !text(row.source.memberName) ||
      !row.source.original ||
      !Object.values(row.source.original).every(text) ||
      receipt.fingerprint !==
        digest({
          binding: state.binding,
          principalId: receipt.principalId,
          operation: 'native.member.add',
          inputAuthority: row.inputAuthority,
          input: parsed.data,
        })
    )
      throw new TeamOwnerError('hold');
    const { name, ...settings } = parsed.data.member;
    if (
      !row.member ||
      row.member.memberId !==
        effectId('roster-member', state.binding.teamId, receipt.commandId, name) ||
      row.member.name !== name ||
      row.member.role !== 'member' ||
      row.member.delivery !== undefined ||
      digest(row.member.settings) !== digest(settings)
    )
      throw new TeamOwnerError('hold');
    if (row.selection) {
      const selected = row.selection,
        binding = selected.delivery;
      if (
        !text(selected.principalId) ||
        !hash(selected.configurationDigest) ||
        !binding ||
        !Object.values(binding).every(text) ||
        binding.backendId !== state.binding.backendId ||
        binding.teamId !== state.binding.teamId ||
        binding.teamName !== state.binding.teamName ||
        binding.runId !== row.source.source.runId ||
        binding.memberId !== row.member.memberId ||
        row.phase === 'prepared'
      )
        throw new TeamOwnerError('hold');
    } else if (row.phase === 'configured' || row.phase === 'completed')
      throw new TeamOwnerError('hold');
  }
}
