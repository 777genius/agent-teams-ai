import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { HostedOperatorWorkspacePanel } from '@renderer/hosted/HostedOperatorWorkspacePanel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  HostedOperatorSurfaceController,
  HostedOperatorSurfaceSnapshot,
} from '@renderer/hosted/createHostedOperatorSurfaceController';

const captures = vi.hoisted(() => ({
  surfaces: null as Record<string, unknown> | null,
  memberLog: null as Record<string, unknown> | null,
}));

vi.mock('@renderer/hosted/HostedOperatorSurfaces', () => ({
  HostedOperatorSurfaces: (props: Record<string, unknown>) => {
    captures.surfaces = props;
    return <div data-testid="operator-surfaces">{props.memberLog as React.ReactNode}</div>;
  },
}));

vi.mock('@features/member-log-stream/renderer/hosted', () => ({
  HostedMemberLogPanel: (props: Record<string, unknown>) => {
    captures.memberLog = props;
    return <div data-testid="member-log-panel" />;
  },
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  captures.surfaces = null;
  captures.memberLog = null;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function renderPanel(controller: HostedOperatorSurfaceController): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<HostedOperatorWorkspacePanel controller={controller} />));
  return container;
}

function fakeController(initial: HostedOperatorSurfaceSnapshot): {
  readonly controller: HostedOperatorSurfaceController;
  publish(snapshot: HostedOperatorSurfaceSnapshot): void;
  readonly mount: ReturnType<typeof vi.fn>;
  readonly reload: ReturnType<typeof vi.fn>;
  readonly unmount: ReturnType<typeof vi.fn>;
} {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const unmount = vi.fn();
  const mount = vi.fn(() => unmount);
  const reload = vi.fn(async () => undefined);
  return {
    controller: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      mount,
      reload,
    },
    publish(next) {
      snapshot = next;
      act(() => listeners.forEach((listener) => listener()));
    },
    mount,
    reload,
    unmount,
  };
}

describe('HostedOperatorWorkspacePanel', () => {
  it('mounts the controller and tears it down with the panel', () => {
    const fake = fakeController({
      status: 'loading',
      readiness: null,
      error: null,
      bindings: {},
    });
    const view = renderPanel(fake.controller);

    expect(fake.mount).toHaveBeenCalledTimes(1);
    expect(view.textContent).toContain('Loading hosted operator workspace');
    act(() => root?.unmount());
    root = null;
    expect(fake.unmount).toHaveBeenCalledTimes(1);
  });

  it('renders a safe retry state without exposing transport failures', () => {
    const fake = fakeController({
      status: 'error',
      readiness: null,
      error: 'Hosted operator readiness is temporarily unavailable.',
      bindings: {},
    });
    const view = renderPanel(fake.controller);

    expect(view.querySelector('[role="alert"]')?.textContent).toContain(
      'Hosted operator readiness is temporarily unavailable.'
    );
    act(() => (view.querySelector('button') as HTMLButtonElement).click());
    expect(fake.reload).toHaveBeenCalledTimes(1);
  });

  it('passes only injected public feature bindings to the operator surfaces', () => {
    const approvalSlice = { kind: 'approval-slice' };
    const diagnostics = { kind: 'diagnostics-props' };
    const memberLogTransport = { kind: 'member-log-transport' };
    const readiness = { kind: 'readiness-projection' };
    const fake = fakeController({
      status: 'ready',
      readiness: readiness as never,
      error: null,
      bindings: {
        approvalSlice: approvalSlice as never,
        diagnostics: diagnostics as never,
        memberLog: {
          selectionId: 'member_log_selection_11111111111111111111111111111111' as never,
          transport: memberLogTransport as never,
          heading: 'Selected member activity',
        },
      },
    });
    const view = renderPanel(fake.controller);

    expect(view.querySelector('[data-testid="operator-surfaces"]')).not.toBeNull();
    expect(captures.surfaces).toMatchObject({ readiness, approvalSlice, diagnostics });
    expect(captures.memberLog).toMatchObject({
      selectionId: 'member_log_selection_11111111111111111111111111111111',
      transport: memberLogTransport,
      heading: 'Selected member activity',
    });
  });
});
