import { DELIVERY_EVENT_LABELS } from '../../contracts';
import { NotificationDestinationPicker } from './NotificationDestinationPicker';

import type { DeliveryEvent } from '../../contracts';
import type { useNotificationChannelsSettings } from '../hooks/useNotificationChannelsSettings';
import type { TeamEventType } from '@shared/types/notifications';

interface DestinationRendererOptions {
  readonly settings: ReturnType<typeof useNotificationChannelsSettings>;
  readonly desktopDisabledEvents: readonly TeamEventType[];
  readonly globalEnabled: boolean;
  readonly budgetDesktopEnabled: boolean;
  readonly saving: boolean;
  readonly onDesktopExcludedChange: (events: TeamEventType[]) => void;
  readonly onBudgetDesktopChange: (checked: boolean) => void;
}

/** One presenter for native toast routing and existing channel.events memberships. */
export function createNotificationDestinationRenderer({
  settings,
  desktopDisabledEvents,
  globalEnabled,
  budgetDesktopEnabled,
  saving,
  onDesktopExcludedChange,
  onBudgetDesktopChange,
}: DestinationRendererOptions) {
  return (
    events: readonly DeliveryEvent[],
    eventEnabled: boolean,
    budgetNativeToast = false
  ): React.JSX.Element => {
    const disabledCount = events.filter((event) => desktopDisabledEvents.includes(event)).length;
    const desktopEnabled = budgetNativeToast
      ? budgetDesktopEnabled
      : disabledCount === 0
        ? true
        : disabledCount === events.length
          ? false
          : 'indeterminate';

    return (
      <NotificationDestinationPicker
        label={events.map((event) => DELIVERY_EVENT_LABELS[event]).join(' / ')}
        events={events}
        channels={settings.channels}
        desktopEnabled={desktopEnabled}
        busy={settings.busy}
        disabled={
          saving ||
          !globalEnabled ||
          !eventEnabled ||
          settings.loading ||
          settings.draft !== null ||
          Boolean(settings.localSettingsUrl || settings.remoteSettingsUnavailable)
        }
        onDesktopChange={(checked) => {
          if (budgetNativeToast) {
            onBudgetDesktopChange(checked);
            return;
          }
          const selection: readonly string[] = events;
          onDesktopExcludedChange(
            checked
              ? desktopDisabledEvents.filter((event) => !selection.includes(event))
              : [...new Set([...desktopDisabledEvents, ...events])]
          );
        }}
        onChannelChange={settings.route}
      />
    );
  };
}
