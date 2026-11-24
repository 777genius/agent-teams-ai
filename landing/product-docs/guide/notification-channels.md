---
title: Notification channels — connect Telegram, Discord, Slack, Teams, and Google Chat
description: Set up secure outbound Agent Teams notifications, test delivery, and route each event to Desktop or a messaging provider.
---

# Notification channels

**Agent Teams → Settings → Notifications → Delivery Channels** lets you send brief, opt-in event alerts to Telegram, Discord, Slack, Microsoft Teams, or Google Chat. A destination is a named bot/chat or webhook you've configured once. Then select it beside each notification type.

## Quick setup

1. Choose **Add channel**, select a provider, enter a friendly name, and copy the credential or incoming webhook URL from that provider.
2. **Save channel**, then select **Test**. Check that your destination received the synthetic test message before enabling automatic delivery.
3. Turn on **Enabled** for the channel and select it under **Deliver to** beside the desired event types. You can select **Desktop + multiple channels**, or send only to an external channel. Desktop is the default.
4. Keep the global notification switch on and make sure **Snooze** isn't active. When they're off, automatic external delivery is paused but manual **Test** remains available.

Never post a bot token or webhook URL in an issue, chat, or screenshot: it grants posting access to its destination. Agent Teams stores these credentials in a separate encrypted local vault. Automatic external alerts contain only a fixed event label, **not** the agent's message, team name, task details, project path, or prompt.

## Telegram

1. In Telegram open [@BotFather](https://t.me/BotFather) and issue `/newbot`. Copy the bot token. [Official BotFather instructions](https://core.telegram.org/bots/features#botfather).
2. Open a private conversation with the new bot and press **Start** before testing. For a channel, add the bot with permission to post.
3. Enter the token in **Bot token** and your destination in **Chat ID or @channelname**. A channel username looks like `@my_team_alerts`; private chats use a numeric chat ID, e.g. `123456789`.
4. Save and send a **Test**. If the recipient cannot receive bot messages, check chat permissions and destination ID.

Token shape: `123456789:<TOKEN_FROM_BOTFATHER>` (illustrative only, not a usable credential). Never use the token as a chat ID.

## Discord

1. In the Discord server, select the destination text channel, then **Edit Channel → Integrations → Webhooks → New Webhook**. Choose the channel and copy its webhook URL. [Official Discord guide](https://discord.com/safety/using-webhooks-and-embeds).
2. In Agent Teams select **Discord**, paste the complete URL into **Official webhook URL**, save, and **Test**.

Expected URL shape: `https://discord.com/api/webhooks/<id>/<token>`. Keep the complete URL confidential. It already identifies the destination, so no second channel ID is needed.

## Slack

1. Open [Slack's official Incoming Webhooks guide](https://api.slack.com/messaging/webhooks). Create a Slack app in your workspace, enable **Incoming Webhooks**, install the app and select a channel.
2. Copy the generated URL, choose **Slack** in Agent Teams, paste it into **Official webhook URL**, then save and **Test**.

Expected shape: `https://hooks.slack.com/services/<workspace>/<channel>/<secret>`. This isn't a normal channel URL copied from your browser.

## Microsoft Teams (Workflows)

Microsoft retired the legacy Office 365 connector-based Incoming Webhooks in May 2026. **Use Teams Workflows**, not an old connector URL. [Official Microsoft guide](https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook).

1. In Teams, open the channel's **… → Workflows** and choose **Send webhook alerts to a channel**, or create a workflow triggered by **When a Teams webhook request is received**.
2. For a custom trigger, set **Who can trigger the flow? → Anyone**. Agent Teams sends no OAuth token; tenant-only modes reject its requests. Configure the destination, save, and copy the **workflow trigger URL** (not a Teams channel link). Treat this URL as a secret.
3. Select **Microsoft Teams** in Agent Teams, paste that URL, save and **Test**. The Thinwrap connector creates the required Adaptive Card envelope automatically.

Typical shape: `https://prod-00.<region>.logic.azure.com/workflows/<id>/triggers/manual/paths/invoke?...&sig=<secret>`. The actual hostname and query vary; copy the exact generated URL.

## Google Chat

1. Open the target Google Chat **space** in your browser. Under its name, select **Apps & integrations → Add webhooks** (workspace admins may need to enable webhooks). [Official Google Chat guide](https://developers.google.com/workspace/chat/quickstart/webhooks).
2. Name the webhook, save it, and use **Copy link**.
3. In Agent Teams choose **Google Chat**, paste the full URL and **Test**.

Expected shape: `https://chat.googleapis.com/v1/spaces/<space>/messages?key=<key>&token=<token>`. Keep **both** query parameters: they authenticate the webhook.

## Troubleshooting

- **“Automatic external delivery is paused…”** means the application's main notification switch is off or Snooze is active. Go to **Settings → Notifications**, enable notifications or clear Snooze; a manual **Test** can still be sent.
- **“Dev Mode”** is a separate macOS warning: local development builds appear to the OS as **Electron** (`com.github.Electron`), so OS toast permission is configured for Electron in **System Settings → Notifications**. It **does not** activate Snooze or disable provider delivery.
- **Test succeeds but no automatic messages:** enable the channel, select that channel beside the event type, check the main switch and Snooze; only *new* events are sent. Existing unread notifications aren't replayed.
- **Credential unavailable:** edit the channel and enter a fresh token/webhook. Secrets aren't shown after saving.
- **Provider rejected the test:** verify permissions, channel/space, and the official webhook URL; use the provider's own creation instructions above.
- **Browser/remote access:** for security, credential configuration requires the Electron app or a page served from the exact same local loopback origin as the API. A remote browser cannot edit these settings.
- **No delivery with the app closed:** this version sends from the running local host. There is no cloud relay, offline queue, or automatic retry.

## Can I add a custom webhook?

Not yet. Arbitrary outbound URLs or templated bodies would need a deliberate SSRF/DNS-rebinding and secret-leakage security review. The five supported integrations use fixed official HTTPS host allowlists; extensions must add a validated connector and transport tests, not bypass those controls. This also keeps automatic notifications limited to safe fixed labels.

For implementation details, see [Notification Channels architecture](https://github.com/777genius/agent-teams-ai/blob/main/src/features/notification-channels/README.md).
