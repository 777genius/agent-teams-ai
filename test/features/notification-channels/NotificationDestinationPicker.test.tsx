import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { NotificationDestinationPicker } from '@features/notification-channels/renderer/ui/NotificationDestinationPicker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryChannelDto } from '@features/notification-channels/contracts';

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const partialChannel: DeliveryChannelDto = {
  id: 'ab84b487-0c13-4bd8-9b4a-57c9947efcd0',
  name: 'Budget Slack',
  provider: 'slack',
  enabled: true,
  hasCredential: true,
  events: ['usage_budget_warning'],
};

async function renderPicker(
  channels: readonly DeliveryChannelDto[],
  allowDesktopOffWithoutExternal: boolean,
  desktopEnabled: boolean | 'indeterminate' = true
) {
  const onDesktopChange = vi.fn();
  await act(async () =>
    root.render(
      <NotificationDestinationPicker
        label="Usage budget"
        events={['usage_budget_warning', 'usage_budget_exceeded']}
        channels={channels}
        desktopEnabled={desktopEnabled}
        allowDesktopOffWithoutExternal={allowDesktopOffWithoutExternal}
        busy={false}
        onDesktopChange={onDesktopChange}
        onChannelChange={vi.fn()}
      />
    )
  );
  const checkbox = container.querySelector<HTMLButtonElement>(
    '[aria-label="Desktop for Usage budget"]'
  );
  expect(checkbox).not.toBeNull();
  return { checkbox: checkbox!, onDesktopChange };
}

describe('Notification destination coverage', () => {
  it('preserves the existing ability to suppress native budget toasts without a webhook', async () => {
    const { checkbox, onDesktopChange } = await renderPicker([], true);
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    expect(onDesktopChange).toHaveBeenCalledWith(false);
  });

  it('names an individual destination and shows its provider mark', async () => {
    await renderPicker([partialChannel], false);
    expect(container.textContent).toContain('Desktop + Budget Slack');
    expect(
      container.querySelector('img[data-notification-provider-logo="slack"]')
    ).not.toBeNull();
  });

  it('does not treat one destination as coverage for two separate event types', async () => {
    const { checkbox } = await renderPicker([partialChannel], false);
    expect(checkbox.disabled).toBe(true);
  });

  it('allows restoring Desktop from a partially disabled grouped row', async () => {
    const { checkbox, onDesktopChange } = await renderPicker([partialChannel], false, 'indeterminate');
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    expect(onDesktopChange).toHaveBeenCalledWith(true);
  });

  it('blocks edits when the parent config is saving even if the popover is already open', async () => {
    await renderPicker([partialChannel], true);
    await act(async () =>
      root.render(
        <NotificationDestinationPicker
          label="Usage budget"
          events={['usage_budget_warning', 'usage_budget_exceeded']}
          channels={[partialChannel]}
          desktopEnabled={true}
          busy={false}
          disabled={true}
          allowDesktopOffWithoutExternal={true}
          onDesktopChange={vi.fn()}
          onChannelChange={vi.fn()}
        />
      )
    );
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Desktop for Usage budget"]')
        ?.disabled
    ).toBe(true);
  });
});
