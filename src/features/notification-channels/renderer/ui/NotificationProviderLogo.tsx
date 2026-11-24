import discordLogo from '../assets/provider-logos/discord.svg';
import googleChatLogo from '../assets/provider-logos/google-chat.svg';
import teamsLogo from '../assets/provider-logos/ms-teams.svg';
import slackLogo from '../assets/provider-logos/slack.svg';
import telegramLogo from '../assets/provider-logos/telegram.svg';

import type { DeliveryProvider } from '../../contracts';

const logoUrls: Record<DeliveryProvider, string> = {
  telegram: telegramLogo,
  discord: discordLogo,
  slack: slackLogo,
  'ms-teams': teamsLogo,
  'google-chat': googleChatLogo,
};

/** Bundled identification marks; never fetch provider images over the network. */
export function NotificationProviderLogo({
  provider,
  className = 'size-4',
}: Readonly<{
  provider: DeliveryProvider;
  className?: string;
}>): React.JSX.Element {
  return (
    <img
      src={logoUrls[provider]}
      alt=""
      aria-hidden="true"
      data-notification-provider-logo={provider}
      className={`shrink-0 object-contain ${className}`}
    />
  );
}
