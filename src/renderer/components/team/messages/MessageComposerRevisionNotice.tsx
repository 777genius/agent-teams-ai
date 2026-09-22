import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import type { RestoreRecoveryResult } from '@renderer/types/composerDraft';

interface MessageComposerRevisionNoticeProps {
  readonly active: boolean;
  readonly originalValid: boolean;
  readonly preparation?: { kind: 'preparing' | 'occupied'; recipient: string } | null;
  readonly onCancel?: () => void;
  readonly onStash: () => Promise<RestoreRecoveryResult>;
}

export const MessageComposerRevisionNotice = ({
  active,
  originalValid,
  preparation,
  onCancel,
  onStash,
}: MessageComposerRevisionNoticeProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  if (!active && !preparation) return null;
  const label = active
    ? originalValid
      ? t('messageComposer.revision.editing')
      : t('messageComposer.revision.unverified')
    : preparation?.kind === 'preparing'
      ? t('messageComposer.revision.preparing')
      : t('messageComposer.revision.occupied', { recipient: preparation?.recipient ?? '' });
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && !originalValid ? (
        <Button type="button" variant="ghost" size="sm" className="h-auto shrink-0 px-1.5 py-0.5 text-amber-100 hover:bg-amber-400/15" onClick={onCancel}>
          {t('messageComposer.revision.continueAsNew')}
        </Button>
      ) : null}
      {!active && preparation?.kind === 'occupied' ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 rounded px-1.5 py-0.5 text-amber-100 hover:bg-amber-400/15"
          onClick={() => void onStash().then((result) => result.kind === 'restored' && onCancel?.())}
        >
          {t('messageComposer.revision.saveDraft')}
        </Button>
      ) : null}
      <Button type="button" variant="ghost" size="sm" className="h-auto shrink-0 px-1.5 py-0.5 text-amber-100 hover:bg-amber-400/15" onClick={onCancel}>
        {t('messageComposer.revision.cancel')}
      </Button>
    </div>
  );
};
