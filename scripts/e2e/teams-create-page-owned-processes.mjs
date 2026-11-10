import assert from 'node:assert/strict';

/** Retain process identities whose parent was already proven to belong to this disposable E2E. */
export function extendOwnedHistory(history, snapshot) {
  assert(history.length > 0 && history.length <= 256, 'Owned Windows process history is unavailable');
  const owned = new Map(history.map((value) => [`${value.pid}:${value.birth}`, value]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const current of snapshot) {
      const key = `${current.pid}:${current.birth}`;
      if (owned.has(key)) continue;
      const parent = [...owned.values()].find((value) => value.pid === current.parent);
      if (!parent || Date.parse(current.birth) < Date.parse(parent.birth)) continue;
      // A reused parent PID cannot grant cleanup authority to a new process.
      const currentParent = snapshot.find((value) => value.pid === parent.pid);
      if (currentParent && currentParent.birth !== parent.birth) continue;
      assert(owned.size < 256, 'Owned Windows process history exceeds safety bound');
      owned.set(key, current);
      changed = true;
    }
  }
  return [...owned.values()];
}

export function remainingOwned(history, snapshot) {
  return history.filter((item) =>
    snapshot.some((current) => current.pid === item.pid && current.birth === item.birth)
  );
}
