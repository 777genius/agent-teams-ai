import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useNotificationChannelsSettings } from '@features/notification-channels/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryChannelDto } from '@features/notification-channels/contracts';

const mockApi = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
  api: { notificationChannels: mockApi },
}));

const channels: DeliveryChannelDto[] = [
  {
    id: 'ab84b487-0c13-4bd8-9b4a-57c9947efcd0',
    name: 'Telegram personal',
    provider: 'telegram',
    enabled: true,
    events: [],
    chatId: '123456',
    hasCredential: true,
  },
  {
    id: 'ab84b487-0c13-4bd8-9b4a-57c9947efcd1',
    name: 'Slack work',
    provider: 'slack',
    enabled: true,
    events: [],
    hasCredential: true,
  },
];

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useNotificationChannelsSettings> | null;

function Probe(): React.JSX.Element {
  current = useNotificationChannelsSettings();
  return <div>{current.channels.length} destinations</div>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  current = null;
  let stored = channels.map((channel) => ({ ...channel, events: [...channel.events] }));
  mockApi.list.mockImplementation(async () => stored.map((channel) => ({ ...channel })));
  mockApi.save.mockImplementation(async (input) => {
    const previous = stored.find((channel) => channel.id === input.id);
    if (!previous) throw new Error('Missing channel');
    const updated = { ...previous, ...input };
    stored = stored.map((channel) => (channel.id === input.id ? updated : channel));
    return updated;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('Event-side destination routing', () => {
  it('keeps legacy providers unsubscribed until explicitly chosen, then supports multi-route and removal', async () => {
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(current?.channels).toHaveLength(2));
    expect(current?.channels.every((channel) => channel.events.length === 0)).toBe(true);

    const telegram = current!.channels[0];
    await act(async () => current!.route(telegram, ['user_inbox'], true));
    await vi.waitFor(() => expect(current?.channels[0].events).toEqual(['user_inbox']));
    const slack = current!.channels[1];
    await act(async () => current!.route(slack, ['user_inbox'], true));
    await vi.waitFor(() => expect(current?.channels[1].events).toEqual(['user_inbox']));

    await act(async () => current!.route(current!.channels[0], ['user_inbox'], false));
    await vi.waitFor(() => expect(current?.channels[0].events).toEqual([]));
    expect(current?.channels[1].events).toEqual(['user_inbox']);
    expect(mockApi.save).toHaveBeenCalledTimes(3);
    expect(mockApi.save.mock.calls.every(([request]) => request.secret === undefined)).toBe(true);
  });

  it('preserves previous subscriptions if a save succeeded but the UI refresh failed', async () => {
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(current?.channels).toHaveLength(2));
    const staleChannel = current!.channels[0];
    const liveList = mockApi.list.getMockImplementation();
    expect(liveList).toBeDefined();
    mockApi.list.mockImplementationOnce(liveList!).mockRejectedValueOnce(
      new Error('Synthetic refresh interruption')
    );

    await act(async () => current!.route(staleChannel, ['user_inbox'], true));
    await vi.waitFor(() => expect(current?.error).not.toBeNull());
    expect(current?.channels[0].events).toEqual([]);

    await act(async () => current!.route(staleChannel, ['task_comment'], true));
    await vi.waitFor(() =>
      expect(current?.channels[0].events).toEqual(['user_inbox', 'task_comment'])
    );
    expect(mockApi.save).toHaveBeenCalledTimes(2);
  });

  it('keeps new subscriptions when a channel is edited from an older UI snapshot', async () => {
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(current?.channels).toHaveLength(2));
    const old = current!.channels[0];
    await act(async () => current!.edit(old));
    await act(async () => current!.updateDraft({ name: 'Renamed Telegram' }));
    await mockApi.save({
      id: old.id, name: old.name, provider: old.provider, enabled: true,
      events: ['user_inbox'], chatId: old.chatId,
    });
    await act(async () => current!.save());
    await vi.waitFor(() => expect(current?.channels[0].name).toBe('Renamed Telegram'));
    expect(current?.channels[0].events).toEqual(['user_inbox']);
    expect(mockApi.save.mock.lastCall?.[0].expectedEvents).toEqual(['user_inbox']);
    expect(mockApi.save.mock.lastCall?.[0].expectedEnabled).toBe(true);
  });

  it('keeps new subscriptions when toggling a channel from a stale snapshot', async () => {
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(current?.channels).toHaveLength(2));
    const old = current!.channels[0];
    await mockApi.save({
      id: old.id, name: old.name, provider: old.provider, enabled: true,
      events: ['task_comment'], chatId: old.chatId,
    });
    await act(async () => current!.toggle(old, false));
    await vi.waitFor(() => expect(current?.channels[0].enabled).toBe(false));
    expect(current?.channels[0].events).toEqual(['task_comment']);
    expect(mockApi.save.mock.lastCall?.[0].expectedEvents).toEqual(['task_comment']);
    expect(mockApi.save.mock.lastCall?.[0].expectedEnabled).toBe(true);
  });

  it('refuses unavailable or disabled provider routes without mutating credentials', async () => {
    mockApi.list.mockResolvedValue([
      { ...channels[0], enabled: false },
      { ...channels[1], hasCredential: false },
    ]);
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(current?.channels).toHaveLength(2));
    await act(async () => {
      current!.route(current!.channels[0], ['user_inbox'], true);
      current!.route(current!.channels[1], ['user_inbox'], true);
    });
    expect(mockApi.save).not.toHaveBeenCalled();
  });
});
