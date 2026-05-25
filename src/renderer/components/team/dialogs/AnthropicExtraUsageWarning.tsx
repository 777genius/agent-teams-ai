import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';

export const ANTHROPIC_SONNET_EXTRA_USAGE_WARNING =
  'Sonnet 1M context can affect billing depending on your Anthropic plan and runtime. Claude Platform lists Sonnet 4.6 1M at standard API pricing, while Claude Code plans can require Extra Usage for Sonnet 1M; enable Limit context to 200K tokens to avoid long-context behavior.';
export const ANTHROPIC_LONG_CONTEXT_PRICING_URL =
  'https://platform.claude.com/docs/en/about-claude/pricing';

export const AnthropicExtraUsageWarning = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <p>
      {ANTHROPIC_SONNET_EXTRA_USAGE_WARNING}{' '}
      <a
        href={ANTHROPIC_LONG_CONTEXT_PRICING_URL}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-amber-100 underline underline-offset-2 hover:text-white"
      >
        {t('modelSelector.anthropicExtraUsage.pricingDocs')}
      </a>
      .
    </p>
  );
};
