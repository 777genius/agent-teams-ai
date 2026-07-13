import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { CheckCircle2, ExternalLink, Globe2 } from 'lucide-react';

import {
  resolveXiaomiMiMoTokenPlanProvider,
  XIAOMI_MIMO_TOKEN_PLAN_CREDENTIAL_URL,
} from '../../core/domain';

import type { XiaomiMiMoTokenPlanProviderId } from '../../core/domain';
import type { FormEvent, JSX } from 'react';

interface XiaomiMiMoTokenPlanSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (providerId: XiaomiMiMoTokenPlanProviderId) => void;
  initialBaseUrl?: string | null;
  onManage?: () => void;
  onOpenPlanPage: (url: string) => void;
}

export const XiaomiMiMoTokenPlanSetupDialog = ({
  open,
  onOpenChange,
  onConnect,
  initialBaseUrl,
  onManage,
  onOpenPlanPage,
}: XiaomiMiMoTokenPlanSetupDialogProps): JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const [baseUrl, setBaseUrl] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const resolution = useMemo(() => resolveXiaomiMiMoTokenPlanProvider(baseUrl), [baseUrl]);

  useEffect(() => {
    setBaseUrl(open ? (initialBaseUrl ?? '') : '');
    setSubmitted(false);
  }, [initialBaseUrl, open]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!resolution.ok) {
      return;
    }
    onConnect(resolution.value.providerId);
    setBaseUrl('');
    setSubmitted(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-2rem),34rem)] gap-4 p-5">
        <DialogHeader>
          <DialogTitle>
            {onManage
              ? `${t('cliStatus.actions.manage')} Xiaomi MiMo Token Plan`
              : t('cliStatus.quickConnect.xiaomiSetupTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('cliStatus.quickConnect.xiaomiSetupDescription')}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="xiaomi-mimo-base-url">
                {t('cliStatus.quickConnect.xiaomiBaseUrlLabel')}
              </Label>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-300 hover:text-sky-200"
                onClick={() => onOpenPlanPage(XIAOMI_MIMO_TOKEN_PLAN_CREDENTIAL_URL)}
              >
                {t('cliStatus.quickConnect.xiaomiOpenPlanPage')}
                <ExternalLink className="size-3" />
              </button>
            </div>
            <Input
              id="xiaomi-mimo-base-url"
              data-testid="xiaomi-mimo-base-url"
              autoComplete="off"
              autoCapitalize="none"
              autoFocus
              spellCheck={false}
              placeholder="https://token-plan-sgp.xiaomimimo.com/v1"
              value={baseUrl}
              aria-invalid={submitted && !resolution.ok}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setSubmitted(false);
              }}
            />
            <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {t('cliStatus.quickConnect.xiaomiBaseUrlHint')}
            </p>
          </div>

          {resolution.ok ? (
            <div
              data-testid="xiaomi-mimo-detected-region"
              role="status"
              aria-live="polite"
              className="flex items-start gap-2.5 rounded-lg border border-emerald-300/25 bg-emerald-300/[0.05] p-3"
            >
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-emerald-200">
                  {t('cliStatus.quickConnect.xiaomiRegionDetected', {
                    region: resolution.value.regionLabel,
                  })}
                </p>
                <p className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                  {resolution.value.canonicalBaseUrl}
                </p>
              </div>
            </div>
          ) : submitted ? (
            <p role="alert" className="text-[11px] leading-relaxed text-red-300">
              {resolution.message}
            </p>
          ) : (
            <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <Globe2 className="size-3.5 shrink-0" />
              {t('cliStatus.quickConnect.xiaomiRegionAutomatic')}
            </div>
          )}

          <DialogFooter>
            {onManage ? (
              <Button type="button" variant="outline" onClick={onManage}>
                {t('cliStatus.actions.manage')}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('cliStatus.quickConnect.cancel')}
            </Button>
            <Button type="submit" data-testid="xiaomi-mimo-continue" disabled={!baseUrl.trim()}>
              {t('cliStatus.quickConnect.continue')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
