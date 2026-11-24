import { useAttentionInbox } from '../hooks/useAttentionInbox';
import { useAttentionInboxNavigation } from '../hooks/useAttentionInboxNavigation';

import { AttentionInboxPanel } from './AttentionInboxPanel';

export function AttentionInboxView({ variant = 'full' }: Readonly<{
  variant?: 'compact' | 'full';
}>): React.JSX.Element | null {
  const { model, loading, error, refresh, supported } = useAttentionInbox();
  const { onOpenTask, onOpenChat, onOpenFull } = useAttentionInboxNavigation();
  if (!supported) return null;

  return (
    <div className={variant === 'compact' ? 'mb-6' : 'flex-1 overflow-auto bg-surface px-6 py-8'}>
      <div className={variant === 'compact' ? undefined : 'mx-auto max-w-5xl'}>
        <AttentionInboxPanel
          variant={variant}
          model={model}
          loading={loading}
          error={error}
          onRetry={refresh}
          onOpenTask={onOpenTask}
          onOpenChat={onOpenChat}
          onOpenFull={variant === 'compact' ? onOpenFull : undefined}
        />
      </div>
    </div>
  );
}
