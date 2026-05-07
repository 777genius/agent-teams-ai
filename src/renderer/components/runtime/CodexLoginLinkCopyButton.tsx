import { useEffect, useState } from 'react';

import { Check, Copy } from 'lucide-react';

interface CodexLoginLinkCopyButtonProps {
  authUrl?: string | null;
  disabled?: boolean;
  size?: 'xs' | 'sm';
}

export function CodexLoginLinkCopyButton({
  authUrl,
  disabled = false,
  size = 'sm',
}: CodexLoginLinkCopyButtonProps): React.JSX.Element | null {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [authUrl]);

  if (!authUrl) {
    return null;
  }

  const handleCopyAuthUrl = (): void => {
    if (!navigator.clipboard) {
      setCopyState('failed');
      return;
    }

    void navigator.clipboard.writeText(authUrl).then(
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
      title="Copy ChatGPT login link"
    >
      {copyState === 'copied' ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy link'}
    </button>
  );
}
