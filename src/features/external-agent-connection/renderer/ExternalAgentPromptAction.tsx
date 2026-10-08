import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@renderer/components/ui/dialog';

import { ExternalAgentPromptDialog } from './ExternalAgentPromptDialog';
import { useConnectionInfo } from './useConnectionInfo';

import type { ExternalAgentConnectionApi } from '../contracts';

export function ExternalAgentPromptAction({
  api,
  local,
  isLight,
  onSettings,
}: Readonly<{
  api: ExternalAgentConnectionApi;
  local: boolean;
  isLight: boolean;
  onSettings(): void;
}>): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const [open, setOpen] = useState(false);
  const { info, error, retrying, retry } = useConnectionInfo(api, open && local);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!local}
          data-testid="external-agent-prompt-open"
          className="h-auto min-h-8 max-w-full whitespace-normal text-left"
        >
          {t('externalPrompt.title')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl p-4 sm:p-6" data-testid="external-agent-prompt-dialog">
        <DialogHeader className="pr-8">
          <DialogTitle className="break-words text-base">{t('externalPrompt.title')}</DialogTitle>
          <DialogDescription>{t('externalPrompt.description')}</DialogDescription>
        </DialogHeader>
        {local && info ? (
          <ExternalAgentPromptDialog
            key={`${info.profileFingerprint}:${info.context.dataRootFingerprint}:${info.context.appInstanceId}`}
            api={api}
            runApi={api.directRun}
            connection={info}
            isLight={isLight}
            onSettings={() => {
              setOpen(false);
              onSettings();
            }}
          />
        ) : (
          <p role="status" className="text-xs text-[var(--color-text-muted)]">
            {error ?? t(local ? 'externalPrompt.loading' : 'externalPrompt.localOnly')}
          </p>
        )}
        {local && (error || info?.mcp.status !== 'ready') && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {t('externalPrompt.retry')}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
