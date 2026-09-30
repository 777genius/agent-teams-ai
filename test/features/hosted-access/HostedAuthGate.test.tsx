import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  getHostedCsrfToken,
  HostedAuthGate,
  type HostedAuthRevalidation,
  type HostedAuthRevalidationResult,
  useHostedAuthRevalidation,
} from '@features/hosted-access/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedAuthStatus } from '@features/hosted-access/contracts';

const authenticated: HostedAuthStatus = {
  mode: 'personal',
  authenticated: true,
  principal: {
    userId: 'user_auth-gate-one' as never,
    sessionId: 'session_auth-gate-one' as never,
    displayName: 'Owner',
    role: 'owner',
    permissions: ['hosted.query'],
    authenticationMethod: 'personal',
  },
  csrfToken: 'csrf-one',
  oidcProviderName: null,
  deploymentId: 'deployment-one',
  bootId: 'boot-one',
  runtimeIsolation: 'trusted_process',
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let current: HostedAuthRevalidation | null;
let mounts: number;

function Child(): React.JSX.Element {
  current = useHostedAuthRevalidation();
  useEffect(() => {
    mounts += 1;
  }, []);
  return <p>Protected child</p>;
}

async function renderGate(): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HostedAuthGate>
        <Child />
      </HostedAuthGate>
    );
    await Promise.resolve();
  });
  return { host, root };
}

async function revalidateCurrent(): Promise<HostedAuthRevalidationResult> {
  let result!: HostedAuthRevalidationResult;
  await act(async () => {
    result = await current!.revalidate();
  });
  return result;
}

describe('HostedAuthGate revalidation', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    current = null;
    mounts = 0;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // A transient status failure must not destroy the authenticated child and its pending intent.
  it('coalesces protected failures, retains the child on 503, then recovers the same identity', async () => {
    const pending = deferred<Response>();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(authenticated))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(json({ ...authenticated, csrfToken: 'csrf-two' }));
    vi.stubGlobal('fetch', fetch);
    const { host, root } = await renderGate();
    expect(mounts).toBe(1);

    let first!: Promise<HostedAuthRevalidationResult>;
    let second!: Promise<HostedAuthRevalidationResult>;
    await act(async () => {
      first = current!.revalidate();
      second = current!.revalidate();
    });
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(current!.availability).toBe('checking');

    let failed!: HostedAuthRevalidationResult;
    await act(async () => {
      pending.resolve(json({ error: 'service_unavailable' }, 503));
      failed = await first;
    });
    expect(failed.kind).toBe('unavailable');
    expect(current!.availability).toBe('unavailable');
    expect(host.textContent).toContain('Protected child');
    expect(mounts).toBe(1);
    expect(getHostedCsrfToken()).toBe('csrf-one');

    expect(await revalidateCurrent()).toMatchObject({
      kind: 'authenticated',
      identity: 'same',
    });
    expect(current!.availability).toBe('available');
    expect(getHostedCsrfToken()).toBe('csrf-two');
    expect(mounts).toBe(1);
    await act(async () => root.unmount());
  });

  // Only a confirmed anonymous status may clear CSRF and unmount the child.
  it('unmounts the protected child after a confirmed anonymous status', async () => {
    const anonymous: HostedAuthStatus = {
      ...authenticated,
      authenticated: false,
      principal: null,
      csrfToken: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(json(authenticated)).mockResolvedValueOnce(json(anonymous))
    );
    const { host, root } = await renderGate();
    expect((await revalidateCurrent()).kind).toBe('unauthenticated');
    expect(host.textContent).not.toContain('Protected child');
    expect(getHostedCsrfToken()).toBeNull();
    await act(async () => root.unmount());
  });

  // A new authority must dispose child-local sensitive state even while auth stays true.
  it('reports an authority change and remounts the child', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(authenticated))
        .mockResolvedValueOnce(json({ ...authenticated, bootId: 'boot-two' }))
    );
    const { root } = await renderGate();
    expect(await revalidateCurrent()).toMatchObject({
      kind: 'authenticated',
      identity: 'changed',
    });
    expect(mounts).toBe(2);
    await act(async () => root.unmount());
  });

  // A hung status request must release its caller without inferring logout.
  it('bounds a stalled status request without unmounting the child', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(authenticated))
        .mockReturnValueOnce(new Promise<Response>(() => {}))
    );
    const { host, root } = await renderGate();
    vi.useFakeTimers();
    let request!: Promise<HostedAuthRevalidationResult>;
    await act(async () => {
      request = current!.revalidate();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(await request).toMatchObject({ kind: 'unavailable' });
    expect(host.textContent).toContain('Protected child');
    expect(getHostedCsrfToken()).toBe('csrf-one');
    await act(async () => root.unmount());
  });
});
