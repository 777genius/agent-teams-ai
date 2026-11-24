import type { DeliveryProvider } from '../../contracts';

export const CHANNEL_SETUP_DOCS_URL =
  'https://agentteams.live/docs/guide/notification-channels';

interface ProviderSetupGuide {
  readonly instruction: string;
  readonly instructionRu: string;
  readonly example: string;
  readonly officialUrl: string;
  readonly officialLabel: string;
}

export const PROVIDER_SETUP_GUIDES: Record<DeliveryProvider, ProviderSetupGuide> = {
  telegram: {
    instruction: 'Create a bot with @BotFather (/newbot), copy its token, then open a chat with your bot and press Start. Enter your chat ID or channel username.',
    instructionRu: 'В Telegram откройте @BotFather, выполните /newbot и скопируйте токен. Откройте чат с ботом и нажмите Start; укажите Chat ID или @имя_канала.',
    example: 'Bot token: 123456789:<token>; Chat ID: 123456789 or @my_alerts',
    officialUrl: 'https://core.telegram.org/bots/features#botfather',
    officialLabel: 'Telegram BotFather instructions',
  },
  discord: {
    instruction: 'In your Discord channel, open Edit Channel → Integrations → Webhooks, create a webhook and copy its complete URL.',
    instructionRu: 'В Discord откройте Edit Channel → Integrations → Webhooks, создайте вебхук и скопируйте всю ссылку.',
    example: 'https://discord.com/api/webhooks/<id>/<token>',
    officialUrl: 'https://discord.com/safety/using-webhooks-and-embeds',
    officialLabel: 'Discord webhook instructions',
  },
  slack: {
    instruction: 'Create a Slack app, enable Incoming Webhooks, install it into your workspace, select a channel and copy the generated webhook URL.',
    instructionRu: 'Создайте Slack App, включите Incoming Webhooks, установите приложение в workspace, выберите канал и скопируйте URL.',
    example: 'https://hooks.slack.com/services/<workspace>/<channel>/<secret>',
    officialUrl: 'https://api.slack.com/messaging/webhooks',
    officialLabel: 'Slack Incoming Webhooks instructions',
  },
  'ms-teams': {
    instruction: 'In Teams select your channel → Workflows → Send webhook alerts to a channel. Save, then copy the Workflows trigger URL (not the channel link).',
    instructionRu: 'В Teams откройте канал → Workflows → Send webhook alerts to a channel. Сохраните workflow и скопируйте ссылку триггера (не ссылку на канал). Старые Office 365 Connectors уже не поддерживаются.',
    example: 'https://prod-00.<region>.logic.azure.com/workflows/<id>/triggers/manual/paths/invoke?...&sig=<secret>',
    officialUrl: 'https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
    officialLabel: 'Teams Workflows instructions',
  },
  'google-chat': {
    instruction: 'In your Google Chat space open Apps & integrations → Add webhooks. Create a webhook and copy the entire link, including key and token.',
    instructionRu: 'В пространстве Google Chat откройте Apps & integrations → Add webhooks. Создайте вебхук и скопируйте полный URL, включая key и token.',
    example: 'https://chat.googleapis.com/v1/spaces/<space>/messages?key=<key>&token=<token>',
    officialUrl: 'https://developers.google.com/workspace/chat/quickstart/webhooks',
    officialLabel: 'Google Chat webhook instructions',
  },
};
