import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listGatewayBindings } from '../../adapters/gatewayProviderApi';
import {
  type GatewayMemberBindingsState,
  useGatewayMemberBindings,
} from '../useGatewayMemberBindings';

vi.mock('../../adapters/gatewayProviderApi', () => ({
  listGatewayBindings: vi.fn(),
  unbindGatewayMember: vi.fn(),
}));
const list = vi.mocked(listGatewayBindings);
const binding = (memberName: string) =>
  ({ memberName }) as Awaited<ReturnType<typeof listGatewayBindings>>[number];
let root: Root;
let container: HTMLDivElement;
let latest: GatewayMemberBindingsState;
const Harness = ({ team }: { team: string }) => {
  latest = useGatewayMemberBindings(team);
  return null;
};
async function render(team: string) {
  await act(async () => {
    root.render(<Harness team={team} />);
  });
}
describe('useGatewayMemberBindings', () => {
  beforeEach(() => {
    list.mockReset();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('waits for bindings before normalization, then refreshes after unbind', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof listGatewayBindings>>) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await render('team-a');
    expect(latest.pending).toBe(true);
    await act(async () => resolve([binding('builder')]));
    expect(latest.boundMemberNames.has('builder')).toBe(true);
    expect(latest.pending).toBe(false);
    list.mockResolvedValue([]);
    await act(() => latest.refresh());
    expect(latest.boundMemberNames.size).toBe(0);
  });

  it('ignores a late response from the previous team', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof listGatewayBindings>>) => void;
    list.mockImplementation((team) =>
      team === 'old'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve([binding('new-member')])
    );
    await render('old');
    await render('new');
    expect(latest.boundMemberNames.has('new-member')).toBe(true);
    await act(async () => resolveOld([binding('old-member')]));
    expect(latest.boundMemberNames.has('new-member')).toBe(true);
    expect(latest.boundMemberNames.has('old-member')).toBe(false);
  });

  it('preserves models when binding lookup fails', async () => {
    list.mockRejectedValue(new Error('Binding lookup failed'));
    await render('team-a');
    expect(latest.error).toBe('Binding lookup failed');
    expect(latest.pending).toBe(true);
  });
  it('keeps forms pending until all binding UI operations, including model refresh, have finished', async () => {
    list.mockResolvedValue([]);
    await render('team-a');
    await act(async () => {
      latest.onBindingPendingChange!(true);
      latest.onBindingPendingChange!(true);
    });
    expect(latest.pending).toBe(true);
    await act(async () => latest.onBindingPendingChange!(false));
    expect(latest.pending).toBe(true);
    await act(async () => latest.onBindingPendingChange!(false));
    expect(latest.pending).toBe(false);
  });
});
