import { RuntimeOwnerError } from './contracts.js';

/** Runtime stays the only writer; an outer synchronous authority fence may enclose its commit. */
export function commitRuntimeInput(commit: () => void, withAuthority?: (commit: () => void) => void): void {
  let committed = false, open = true;
  const guarded = () => {
    if (!open || committed) throw new RuntimeOwnerError('hold');
    committed = true;
    commit();
  };
  try {
    if (withAuthority) {
      const result: unknown = withAuthority(guarded);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw new RuntimeOwnerError('hold');
      }
      if (!committed) throw new RuntimeOwnerError('hold');
    } else guarded();
  } finally { open = false; }
}
