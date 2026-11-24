import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { ChevronDown, Monitor } from 'lucide-react';

import type { DeliveryChannelDto, DeliveryEvent } from '../../contracts';

interface NotificationDestinationPickerProps {
  readonly label: string;
  readonly events: readonly DeliveryEvent[];
  readonly channels: readonly DeliveryChannelDto[];
  readonly desktopEnabled: boolean | 'indeterminate';
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly allowDesktopOffWithoutExternal?: boolean;
  readonly onDesktopChange: (checked: boolean) => void;
  readonly onChannelChange: (
    channel: DeliveryChannelDto,
    events: readonly DeliveryEvent[],
    checked: boolean
  ) => void;
}

/** View the existing channel.events subscriptions by event, never expose credentials. */
export function NotificationDestinationPicker({
  label,
  events,
  channels,
  desktopEnabled,
  busy,
  disabled = false,
  allowDesktopOffWithoutExternal = false,
  onDesktopChange,
  onChannelChange,
}: NotificationDestinationPickerProps): React.JSX.Element {
  const subscribed = channels.filter((channel) =>
    channel.events.some((event) => events.includes(event))
  );
  const active = subscribed.filter((channel) => channel.enabled && channel.hasCredential);
  const hasDesktop = desktopEnabled !== false;
  const summary = hasDesktop
    ? active.length === 0
      ? 'Desktop'
      : `Desktop + ${active.length}`
    : active.length === 0
      ? 'No delivery'
      : active.length === 1
        ? active[0].name
        : `${active.length} channels`;
  // Never strand half of a grouped event row without any active route.
  const canDisableDesktop = events.every((event) =>
    channels.some(
      (channel) =>
        channel.enabled && channel.hasCredential && channel.events.includes(event)
    )
  );
  const disabledControl = busy || disabled;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-2 max-w-44 gap-1.5"
          disabled={disabledControl}
          aria-label={`Destinations for ${label}`}
          data-delivery-events={events.join(',')}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="space-y-3" aria-label={`Destinations for ${label}`}>
        <p className="text-xs font-semibold">Deliver to</p>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            aria-label={`Desktop for ${label}`}
            checked={desktopEnabled}
            disabled={
              disabledControl ||
              (!allowDesktopOffWithoutExternal && !canDisableDesktop && desktopEnabled === true)
            }
            onCheckedChange={(value) => onDesktopChange(value === true)}
          />
          <Monitor className="size-3.5" />
          Desktop
        </label>
        {channels.length > 0 && <div className="border-t border-[var(--color-border-subtle)]" />}
        {channels.map((channel) => {
          const selected = events.filter((event) => channel.events.includes(event)).length;
          const checked =
            selected === 0 ? false : selected === events.length ? true : 'indeterminate';
          const available = channel.enabled && channel.hasCredential;
          return (
            <label key={channel.id} className="flex items-start gap-2 text-xs">
              <Checkbox
                aria-label={`Deliver ${label} to ${channel.name}`}
                checked={checked}
                disabled={disabledControl || !available}
                onCheckedChange={(value) => onChannelChange(channel, events, value === true)}
              />
              <span className="min-w-0">
                <span className="block break-words">{channel.name}</span>
                {!channel.hasCredential && (
                  <span className="text-[var(--color-text-muted)]">Credential unavailable</span>
                )}
                {channel.hasCredential && !channel.enabled && (
                  <span className="text-[var(--color-text-muted)]">Enable channel first</span>
                )}
              </span>
            </label>
          );
        })}
        {channels.length === 0 && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Add and enable a channel above to route externally.
          </p>
        )}
        {!hasDesktop && active.length === 0 && (
          <p className="text-xs text-amber-500" role="status">
            No active destination. Enable a channel or restore Desktop.
          </p>
        )}
        <p className="text-xs text-[var(--color-text-muted)]">
          External messages contain only the event type, not team or agent content.
        </p>
      </PopoverContent>
    </Popover>
  );
}
