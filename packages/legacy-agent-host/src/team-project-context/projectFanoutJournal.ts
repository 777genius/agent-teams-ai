import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import type { TeamStore } from '../team/ports.js';

export interface ProjectFanoutPlan {
  commandId: string;
  fingerprint: string;
  sequence: number;
  phase: 'prepared' | 'completed';
}

/** The atomic current record owns the whole original plan; archives are secondary settled history. */
export function projectFanoutJournal<T extends ProjectFanoutPlan>(
  store: Pick<TeamStore, 'read' | 'write'>,
  directory: string,
  validate: (value: unknown) => T
) {
  const path = `${directory}/current.json`;
  const archive = (commandId: string) => `${directory}/commands/${digest(commandId)}.json`;
  function read(name: string): T | undefined {
    const value = store.read<unknown>(name);
    if (value === undefined) return undefined;
    try { return validate(value); } catch { throw new TeamOwnerError('hold'); }
  }
  const current = () => read(path);
  return {
    current,
    original(commandId: string): T | undefined {
      const active = current();
      if (active?.commandId === commandId) return active;
      const found = read(archive(commandId));
      if (found && found.commandId !== commandId) throw new TeamOwnerError('hold');
      if (found && found.phase !== 'completed') throw new TeamOwnerError('hold');
      return found;
    },
    prepare(plan: Omit<T, 'sequence'>): T {
      const previous = current();
      if (previous?.phase === 'prepared') throw new TeamOwnerError('hold');
      if (read(archive(plan.commandId)) || previous?.commandId === plan.commandId)
        throw new TeamOwnerError('conflict');
      const selected = validate({ ...plan, sequence: (previous?.sequence ?? 0) + 1 });
      // If interrupted here, the original settled current remains authoritative.
      if (previous) store.write(archive(previous.commandId), previous);
      store.write(path, selected);
      return selected;
    },
    complete(plan: T): T {
      const active = current();
      if (!active || active.commandId !== plan.commandId || active.fingerprint !== plan.fingerprint)
        throw new TeamOwnerError('hold');
      const completed = validate({ ...active, phase: 'completed' });
      store.write(path, completed);
      return completed;
    },
  };
}
