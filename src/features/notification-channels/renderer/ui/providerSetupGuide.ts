import type { DeliveryProvider } from '../../contracts';

export const CHANNEL_SETUP_DOCS_URL =
  'https://agentteams.live/docs/guide/notification-channels';

interface ProviderSetupGuide {
  readonly example: string;
  readonly officialUrl: string;
}

export const PROVIDER_SETUP_GUIDES: Record<DeliveryProvider, ProviderSetupGuide> = {
  telegram: {
    example: 'Bot token: 123456789:<token>; Chat ID: 123456789 or @my_alerts',
    officialUrl: 'https://core.telegram.org/bots/features#botfather',
  },
  discord: {
    example: 'https://discord.com/api/webhooks/<id>/<token>',
    officialUrl: 'https://discord.com/safety/using-webhooks-and-embeds',
  },
  slack: {
    example: 'https://hooks.slack.com/services/<workspace>/<channel>/<secret>',
    officialUrl: 'https://api.slack.com/messaging/webhooks',
  },
  'ms-teams': {
    example: 'https://prod-00.<region>.logic.azure.com/workflows/<id>/triggers/manual/paths/invoke?...&sig=<secret>',
    officialUrl: 'https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
  },
  'google-chat': {
    example: 'https://chat.googleapis.com/v1/spaces/<space>/messages?key=<key>&token=<token>',
    officialUrl: 'https://developers.google.com/workspace/chat/quickstart/webhooks',
  },
};
