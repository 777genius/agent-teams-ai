import type { TeamEventType } from '@shared/types/notifications';

export const NOTIFICATION_CHANNELS_IPC = {
  list: 'notification-channels:list',
  save: 'notification-channels:save',
  remove: 'notification-channels:remove',
  test: 'notification-channels:test',
} as const;

export const NOTIFICATION_CHANNELS_HTTP = '/api/notification-channels';

export const NOTIFICATION_DELIVERY_EVENTS = [
  'lead_inbox',
  'user_inbox',
  'task_clarification',
  'task_status_change',
  'task_comment',
  'task_created',
  'cross_team_message',
  'team_launched',
  'schedule_completed',
  'usage_budget_warning',
  'task_review_requested',
  'task_blocked',
  'all_tasks_completed',
  'team_launch_incomplete',
  'runtime_recovery',
  'schedule_failed',
  'usage_budget_exceeded',
] as const satisfies readonly TeamEventType[];

export const NOTIFICATION_DESKTOP_ROUTABLE_EVENTS = NOTIFICATION_DELIVERY_EVENTS.filter(
  (event) => event !== 'usage_budget_warning' && event !== 'usage_budget_exceeded'
);

export type DeliveryEvent = (typeof NOTIFICATION_DELIVERY_EVENTS)[number];
export type DeliveryProvider = 'telegram' | 'discord' | 'slack' | 'ms-teams' | 'google-chat';

export const DELIVERY_PROVIDERS: readonly { id: DeliveryProvider; label: string; hint: string }[] =
  [
    { id: 'telegram', label: 'Telegram', hint: 'Bot token from @BotFather and chat ID' },
    { id: 'discord', label: 'Discord', hint: 'Incoming webhook URL' },
    { id: 'slack', label: 'Slack', hint: 'Incoming webhook URL' },
    { id: 'ms-teams', label: 'Microsoft Teams', hint: 'Workflows webhook URL' },
    { id: 'google-chat', label: 'Google Chat', hint: 'Incoming webhook URL' },
  ];

export const DELIVERY_EVENT_LABELS: Record<DeliveryEvent, string> = {
  lead_inbox: 'Team lead inbox message',
  user_inbox: 'Message for you',
  task_status_change: 'Task status changed',
  task_comment: 'New task comment',
  task_created: 'Task created',
  cross_team_message: 'Cross-team message',
  team_launched: 'Team launched',
  schedule_completed: 'Scheduled run completed',
  usage_budget_warning: 'Usage budget warning',
  task_clarification: 'Clarification needed',
  task_review_requested: 'Review requested',
  task_blocked: 'Task blocked',
  all_tasks_completed: 'All tasks completed',
  team_launch_incomplete: 'Team launch needs attention',
  runtime_recovery: 'Runtime recovery',
  schedule_failed: 'Scheduled run failed',
  usage_budget_exceeded: 'Usage budget exceeded',
};

export type DeliveryFailureCode =
  | 'credentials_missing'
  | 'authentication_failed'
  | 'invalid_recipient'
  | 'rate_limited'
  | 'network_error'
  | 'delivery_failed';

export interface ChannelTestStatus {
  at: string;
  success: boolean;
  code?: DeliveryFailureCode;
}

export interface DeliveryChannelDto {
  id: string;
  name: string;
  provider: DeliveryProvider;
  enabled: boolean;
  events: DeliveryEvent[];
  chatId?: string;
  hasCredential: boolean;
  lastTest?: ChannelTestStatus;
}

export interface SaveDeliveryChannelRequest {
  id?: string;
  name: string;
  provider: DeliveryProvider;
  enabled: boolean;
  events: DeliveryEvent[];
  /** New credential. Omit on edits to retain the existing secret. Never returned to clients. */
  secret?: string;
  chatId?: string;
}

export interface NotificationChannelsApi {
  list(): Promise<DeliveryChannelDto[]>;
  save(request: SaveDeliveryChannelRequest): Promise<DeliveryChannelDto>;
  remove(id: string): Promise<void>;
  test(id: string): Promise<ChannelTestStatus>;
}
