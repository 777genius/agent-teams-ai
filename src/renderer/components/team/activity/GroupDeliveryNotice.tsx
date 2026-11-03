import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';

import type { InboxMessage } from '@shared/types';

export const GroupDeliveryNotice = ({
  teamName,
  message,
}: {
  teamName: string;
  message: InboxMessage;
}) => {
  const { t } = useAppTranslation('team');
  const recipients = message.groupChatId ? message.groupDeliverySummary?.recipients : undefined;
  const recordedAt = message.groupDeliverySummary?.recordedAt;
  const [unconfirmed, setUnconfirmed] = useState<string[]>([]);

  useEffect(() => {
    setUnconfirmed([]);
    if (!recipients || !recordedAt) return;
    const pending = recipients.filter(({ status }) => status === 'queued' || status === 'unknown');
    if (!pending.length) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.parse(recordedAt) + 120_000;

    async function refresh(): Promise<void> {
      const statuses = await Promise.allSettled(
        pending.map(async (recipient) => ({
          recipient,
          status: await api.teams.getOpenCodeRuntimeDeliveryStatus(
            teamName,
            recipient.physicalMessageId
          ),
        }))
      );
      if (!active) return;
      setUnconfirmed(
        statuses.flatMap((result) =>
          result.status === 'fulfilled' &&
          result.value.status?.ledgerStatus === 'failed_terminal' &&
          result.value.status.reason === 'group_delivery_unconfirmed'
            ? [result.value.recipient.memberName]
            : []
        )
      );
      if (
        Date.now() < deadline &&
        statuses.some(
          (result) => result.status === 'rejected' || result.value.status?.responsePending !== false
        )
      ) {
        timer = setTimeout(() => void refresh(), 15_000);
      }
    }

    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [teamName, recipients, recordedAt]);

  return unconfirmed.length ? (
    <p role="status" className="px-3 py-1 text-xs text-amber-400">
      {t('messages.groups.deliveryUnconfirmed', { names: unconfirmed.join(', ') })}
    </p>
  ) : null;
};
