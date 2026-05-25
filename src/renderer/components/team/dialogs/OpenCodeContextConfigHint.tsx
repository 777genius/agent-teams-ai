import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { ChevronDown, ChevronRight, ExternalLink, Info } from 'lucide-react';

const OPENCODE_CONFIG_DOCS_URL = 'https://opencode.ai/docs/config/';
const OPENCODE_PROVIDERS_DOCS_URL = 'https://opencode.ai/docs/providers';

const OPENCODE_CONTEXT_CONFIG_EXAMPLE = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "models": {
        "your-model": {
          "limit": {
            "context": 10000,
            "output": 2000
          }
        }
      }
    }
  },
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 2000
  }
}`;

export const OpenCodeContextConfigHint = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-cyan-500/20 bg-cyan-500/5 text-[11px] leading-relaxed text-cyan-100">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="flex h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-md px-3 py-2 text-left text-[11px] font-normal text-cyan-100 hover:bg-cyan-500/10 hover:text-cyan-50"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="mt-0.5 size-3.5 shrink-0" />
        )}
        <Info className="mt-0.5 size-3.5 shrink-0 text-cyan-300" />
        <span className="min-w-0">{t('openCodeContextConfigHint.summary')}</span>
      </Button>

      {expanded ? (
        <div className="space-y-2 border-t border-cyan-500/15 px-3 pb-3 pt-2">
          <p className="text-cyan-100/90">{t('openCodeContextConfigHint.description')}</p>
          <pre className="max-h-72 overflow-auto rounded-md border border-cyan-500/20 bg-black/25 p-2 font-mono text-[10px] leading-relaxed text-cyan-50">
            <code>{OPENCODE_CONTEXT_CONFIG_EXAMPLE}</code>
          </pre>
          <p className="text-cyan-100/80">
            {t('openCodeContextConfigHint.replacePrefix')} <code className="font-mono">local</code>{' '}
            {t('openCodeContextConfigHint.and')} <code className="font-mono">your-model</code>{' '}
            {t('openCodeContextConfigHint.replaceSuffix')}{' '}
            <code className="font-mono">stay below 10000 tokens</code>{' '}
            {t('openCodeContextConfigHint.promptInstructionsSuffix')}
          </p>
          <div className="flex flex-wrap gap-3 text-cyan-100/90">
            <a
              href={OPENCODE_PROVIDERS_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-cyan-50"
            >
              {t('openCodeContextConfigHint.providerLimits')}
              <ExternalLink className="size-3" />
            </a>
            <a
              href={OPENCODE_CONFIG_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-cyan-50"
            >
              {t('openCodeContextConfigHint.compactionConfig')}
              <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
};
