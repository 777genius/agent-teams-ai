import { randomUUID } from 'node:crypto';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import {
  listTeamCommandEntries,
  teamCommandPath,
  validateCommandEntry,
} from '../team/commandEntries.js';
import { workSyncCommandFingerprint, validateWorkSyncCommandReceipt } from './commandContracts.js';
import type { WorkSyncCommandReceipt } from './commandContracts.js';
import type { JsonValue } from '../contracts.js';
import type { TeamBinding } from '../team/contracts.js';
import type { TeamStore } from '../team/ports.js';
import type { captureNativeInputAuthority } from '../composition/captureNativeInputAuthority.js';

/** Existing Team command namespace; exact original-input authority is fixed before any awaited effect. */
export function createTeamWorkSyncCommands(options: {
  store: TeamStore;
  binding: TeamBinding;
  principalId: string;
  reserved(commandId: string): boolean;
  authorize(action: 'read' | 'write'): number;
  invalidate(): void;
}) {
  function read(commandId: string) {
    const raw = options.store.read<WorkSyncCommandReceipt>(teamCommandPath(commandId));
    if (!raw) return undefined;
    const entry = validateCommandEntry(raw);
    if (!('family' in entry) || entry.family !== 'work-sync') throw new TeamOwnerError('conflict');
    if (digest(entry.binding) !== digest(options.binding)) throw new TeamOwnerError('hold');
    if (entry.principalId !== options.principalId) throw new TeamOwnerError('forbidden');
    return entry;
  }
  return {
    lookup(commandId: string) {
      return options.store.fenced(() => {
        options.authorize('read');
        return structuredClone(read(commandId));
      });
    },
    accepted() {
      return options.store.fenced(() => {
        options.authorize('read');
        return listTeamCommandEntries(options.store)
          .filter(
            (entry): entry is WorkSyncCommandReceipt =>
              'family' in entry &&
              entry.family === 'work-sync' &&
              entry.phase === 'completed' &&
              entry.principalId === options.principalId &&
              digest(entry.binding) === digest(options.binding)
          )
          .map((entry) => structuredClone(entry));
      });
    },
    /** Callback is the existing feature use case supplied by private composition, never an MCP argument. */
    async execute(
      commandId: string,
      operation: WorkSyncCommandReceipt['operation'],
      payload: JsonValue,
      authority: ReturnType<typeof captureNativeInputAuthority>,
      effect: (original: Readonly<WorkSyncCommandReceipt>) => Promise<JsonValue>
    ) {
      authority.assertCurrent();
      if (authority.team.principalId !== options.principalId) throw new TeamOwnerError('forbidden');
      const receipt = options.store.fenced(() => {
        authority.assertTeamCurrent();
        const revision = options.authorize('write');
        if (revision !== authority.team.authorityRevision) throw new TeamOwnerError('forbidden');
        if (options.reserved(commandId)) throw new TeamOwnerError('conflict');
        listTeamCommandEntries(options.store);
        const request = {
          binding: options.binding,
          commandId,
          principalId: options.principalId,
          authorityRevision: revision,
          inputAuthority: authority.fingerprint,
          nativeInput: {
            team: authority.team,
            original: authority.original,
            runtime: authority.runtime,
          },
          operation,
          payload,
        };
        const fingerprint = workSyncCommandFingerprint(request);
        const prior = read(commandId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new TeamOwnerError('conflict');
          if (prior.phase !== 'completed') throw new TeamOwnerError('hold');
          return prior;
        }
        const prepared: WorkSyncCommandReceipt = {
          ...request,
          schemaVersion: 1,
          family: 'work-sync',
          fingerprint,
          receivedAt: new Date().toISOString(),
          mutationId: randomUUID(),
          phase: 'prepared',
        };
        options.store.write(teamCommandPath(commandId), prepared);
        const running = { ...prepared, phase: 'running' as const };
        options.store.write(teamCommandPath(commandId), running);
        return running;
      });
      if (receipt.phase === 'completed') return structuredClone(receipt.result!);
      // Running/held receipts never automatically invoke the effect again after a lost response.
      {
        authority.assertCurrent();
        const result = await effect(Object.freeze(structuredClone(receipt)));
        authority.assertCurrent();
        return options.store.fenced(() => {
          authority.assertTeamCurrent();
          if (options.authorize('write') !== receipt.authorityRevision)
            throw new TeamOwnerError('forbidden');
          const current = read(commandId);
          if (
            !current ||
            current.phase !== 'running' ||
            current.fingerprint !== receipt.fingerprint
          )
            throw new TeamOwnerError('hold');
          const completed = { ...current, phase: 'completed' as const, result };
          validateWorkSyncCommandReceipt(completed);
          options.store.write(teamCommandPath(commandId), completed);
          options.invalidate();
          return structuredClone(result);
        });
      }
    },
  };
}
