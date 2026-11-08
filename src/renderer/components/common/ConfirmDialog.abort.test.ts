import { describe, expect, it } from 'vitest';

import { confirm } from './ConfirmDialog';

const prompt = { title: 'Replace draft?', message: 'Replace pending work?' };

describe('owner-scoped confirmation cancellation', () => {
  it('returns false when the confirmation owner unmounts/aborts', async () => {
    const owner = new AbortController();
    const pending = confirm({ ...prompt, signal: owner.signal });
    owner.abort();
    await expect(pending).resolves.toBe(false);
  });

  it('does not dismiss a newer unrelated confirmation when the old owner aborts', async () => {
    const oldOwner = new AbortController();
    const newOwner = new AbortController();
    const first = confirm({ ...prompt, signal: oldOwner.signal });
    const second = confirm({ title: 'Unrelated confirmation', message: 'Continue?', signal: newOwner.signal });

    await expect(first).resolves.toBe(false);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });

    oldOwner.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    newOwner.abort();
    await expect(second).resolves.toBe(false);
  });

  it('never replaces another open confirmation with an already-aborted owner', async () => {
    const currentOwner = new AbortController();
    const oldOwner = new AbortController();
    oldOwner.abort();

    const current = confirm({ ...prompt, signal: currentOwner.signal });
    await expect(confirm({ ...prompt, signal: oldOwner.signal })).resolves.toBe(false);

    let currentSettled = false;
    void current.then(() => { currentSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(currentSettled).toBe(false);

    currentOwner.abort();
    await expect(current).resolves.toBe(false);
  });
});
