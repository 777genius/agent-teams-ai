import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeFreeTierUpdateAction } from './OpenCodeFreeTierUpdateAction';

describe('OpenCodeFreeTierUpdateAction', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('offers the existing update action for an installed version below the free-tier minimum', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onUpdate = vi.fn();

    await act(async () => {
      root.render(<OpenCodeFreeTierUpdateAction version="1.17.18" compact onUpdate={onUpdate} />);
    });
    const button = host.querySelector('button');
    expect(button?.textContent).toContain('v1.17.18 → v1.18.0+');
    await act(async () => button?.click());
    expect(onUpdate).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it('shows the installed and latest versions when a newer release is available', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <OpenCodeFreeTierUpdateAction version="1.18.1" latestVersion="1.18.32" compact />
      );
    });
    expect(host.querySelector('button')?.textContent).toContain('v1.18.1 → v1.18.32');
    await act(async () => root.unmount());
  });

  it('marks the free-tier version requirement with a warning icon', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<OpenCodeFreeTierUpdateAction version="1.17.18" />));
    expect(host.querySelector('p svg')).not.toBeNull();
    expect(host.textContent).toContain('Update to 1.18.0 or newer');
    await act(async () => root.unmount());
  });
});
