import React, { act, StrictMode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRetainedLaunchOwner } from '../../../../../src/renderer/components/team/dialogs/useRetainedLaunchOwner';
import { invalidateContextScopedRequestEpoch } from '../../../../../src/renderer/store/utils/contextScopedRequestEpoch';

import type { RetainedLegacyLaunchChoice } from '../../../../../src/features/agent-backend/contracts/retainedLegacyLaunch';

const closeChoice = vi.hoisted(() => vi.fn(async (_choice?: RetainedLegacyLaunchChoice) => undefined));
vi.mock('@features/agent-backend/renderer', () => ({ closeRetainedLegacyLaunch: closeChoice }));
type Owner = ReturnType<typeof useRetainedLaunchOwner>;
type Intent = ReturnType<Owner['begin']>;
const unmounts = new Set<() => void>();
let sequence = 0;
function choice(): RetainedLegacyLaunchChoice {
  return { scopeId: `TEST-owner-${++sequence}`, teamName: 'TEST-owner-team', mode: 'original-runtime',
    projectPath: '/TEST/project', expiresAt: Date.now() + 600_000 };
}
function fixture(strict = false) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let owner!: Owner;
  function Harness({ team, onLayout }: { team: string; onLayout?: (value: Owner) => void }) {
    owner = useRetainedLaunchOwner(team);
    useLayoutEffect(() => { onLayout?.(owner); }, [team, onLayout]);
    return null;
  }
  const unmount = () => { root.unmount(); host.remove(); unmounts.delete(unmount); };
  unmounts.add(unmount);
  return {
    get owner() { return owner; },
    async render(team: string, onLayout?: (value: Owner) => void) {
      await act(async () => {
        const child = <Harness team={team} onLayout={onLayout} />;
        root.render(strict ? <StrictMode>{child}</StrictMode> : child);
      });
    },
    async unmount() { await act(async () => { unmount(); }); },
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  closeChoice.mockClear();
  invalidateContextScopedRequestEpoch();
});
afterEach(async () => {
  await act(async () => { for (const unmount of unmounts) unmount(); });
  vi.unstubAllGlobals();
});

describe('retained launch dialog intent ownership', () => {
  it('aborts each superseded intent and keeps only the current generation', async () => {
    const view = fixture();
    await view.render('TEST-A');
    const first = view.owner.begin();
    expect(view.owner.current(first)).toBe(true);
    const second = view.owner.begin();
    expect(first.signal.aborted).toBe(true);
    expect(view.owner.current(first)).toBe(false);
    expect(view.owner.current(second)).toBe(true);
    view.owner.close();
    expect(second.signal.aborted).toBe(true);
    expect(view.owner.current(second)).toBe(false);
    const third = view.owner.begin();
    expect(third.signal.aborted).toBe(false);
    expect(view.owner.current(third)).toBe(true);
  });

  it('does not revive an old intent after the same team key returns', async () => {
    const view = fixture();
    await view.render('TEST-A');
    const oldOwner = view.owner, oldIntent = oldOwner.begin(), selected = choice();
    oldOwner.adopt(selected);
    await view.render('TEST-B');
    expect(oldIntent.signal.aborted).toBe(true);
    expect(oldOwner.current(oldIntent)).toBe(false);
    expect(closeChoice.mock.calls.filter(([value]) => value === selected)).toHaveLength(1);
    await view.render('TEST-A');
    expect(view.owner.current(oldIntent)).toBe(false);
    expect(view.owner.current(view.owner.begin())).toBe(true);
  });

  it('keeps a new team intent alive when the old team passive cleanup runs later', async () => {
    const view = fixture();
    await view.render('TEST-A');
    const oldOwner = view.owner, oldIntent = oldOwner.begin();
    let next!: Intent;
    await view.render('TEST-B', current => { next = current.begin(); });
    expect(oldIntent.signal.aborted).toBe(true);
    expect(next.signal.aborted).toBe(false);
    expect(view.owner.current(next)).toBe(true);
    oldOwner.close();
    expect(next.signal.aborted).toBe(false);
    expect(view.owner.current(next)).toBe(true);
  });

  it('closes only the replaced choice and releases the current choice on unmount', async () => {
    const view = fixture();
    await view.render('TEST-A');
    const original = choice(), replacement = choice();
    view.owner.adopt(original);
    view.owner.adopt(original);
    expect(closeChoice.mock.calls.filter(([value]) => value === original)).toHaveLength(0);
    view.owner.adopt(replacement);
    expect(closeChoice.mock.calls.filter(([value]) => value === original)).toHaveLength(1);
    const pending = view.owner.begin();
    await view.unmount();
    expect(pending.signal.aborted).toBe(true);
    expect(view.owner.current(pending)).toBe(false);
    expect(closeChoice.mock.calls.filter(([value]) => value === replacement)).toHaveLength(1);
  });

  it('rejects an intent after the original backend context changes', async () => {
    const view = fixture();
    await view.render('TEST-A');
    const pending = view.owner.begin();
    invalidateContextScopedRequestEpoch();
    expect(view.owner.current(pending)).toBe(false);
    const current = view.owner.begin();
    expect(pending.signal.aborted).toBe(true);
    expect(view.owner.current(current)).toBe(true);
  });

  it('survives development effect replay and closes the adopted scope on real unmount', async () => {
    const view = fixture(true);
    await view.render('TEST-A');
    const pending = view.owner.begin(), selected = choice();
    view.owner.adopt(selected);
    await view.render('TEST-A');
    expect(pending.signal.aborted).toBe(false);
    expect(view.owner.current(pending)).toBe(true);
    expect(closeChoice.mock.calls.filter(([value]) => value === selected)).toHaveLength(0);
    await view.unmount();
    expect(pending.signal.aborted).toBe(true);
    expect(closeChoice.mock.calls.filter(([value]) => value === selected)).toHaveLength(1);
  });
});
