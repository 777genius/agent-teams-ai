import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Check, Copy } from 'lucide-react';

interface CodexLoginLinkCopyButtonProps {
  authUrl?: string | null;
  userCode?: string | null;
  disabled?: boolean;
  size?: 'xs' | 'sm';
}

export const CodexLoginLinkCopyButton = ({
  authUrl,
  userCode,
  disabled = false,
  size = 'sm',
}: CodexLoginLinkCopyButtonProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('common');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [authUrl, userCode]);

  if (!authUrl) {
    return null;
  }

  const handleCopyAuthUrl = (): void => {
    if (!navigator.clipboard) {
      setCopyState('failed');
      return;
    }

    const text = userCode ? `${authUrl}\n${t('code.code')}: ${userCode}` : authUrl;
    void navigator.clipboard.writeText(text).then(
      () => setCopyState('copied'),
      () => setCopyState('failed')
    );
  };

  const sizeClassName = size === 'xs' ? 'px-2 py-1 text-[10px]' : 'px-2.5 py-1.5 text-xs';

  return (
    <button
      type="button"
      onClick={handleCopyAuthUrl}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border font-medium text-amber-300 transition-colors hover:bg-white/5 disabled:opacity-50 ${sizeClassName}`}
      style={{
        borderColor: 'rgba(245, 158, 11, 0.28)',
        backgroundColor: 'rgba(245, 158, 11, 0.08)',
      }}
      title={userCode ? t('codexLogin.copyLoginLinkAndCode') : t('codexLogin.copyLoginLink')}
    >
      {copyState === 'copied' ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copyState === 'copied'
        ? t('actions.copied')
        : copyState === 'failed'
          ? t('codexLogin.copyFailed')
          : userCode
            ? t('codexLogin.copyLinkAndCode')
            : t('codexLogin.copyLink')}
    </button>
  );
};

export const CodexLoginUserCodeBadge = ({
  userCode,
}: {
  userCode?: string | null;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('common');
  if (!userCode) {
    return null;
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium"
      style={{
        borderColor: 'rgba(245, 158, 11, 0.22)',
        backgroundColor: 'rgba(245, 158, 11, 0.06)',
        color: '#fbbf24',
      }}
      title={t('codexLogin.enterCodeOnLoginPage')}
    >
      {t('code.code')} <span className="font-mono tracking-wide text-amber-100">{userCode}</span>
    </span>
  );
};
