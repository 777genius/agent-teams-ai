import { useEffect, useState } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
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
    const host = isHostTeamSelectionKey(teamName);

    async function refresh(): Promise<void> {
      const statuses = await Promise.allSettled(
        pending.map(async (recipient) => {
          if (host) {
            const read = api.teams.getHostMessageDeliveryStatus;
            if (!read) throw new Error('Host delivery observation unavailable');
            const status = await read(teamName, recipient.physicalMessageId);
            if (
              status.source !== 'captured-host' ||
              status.messageId !== recipient.physicalMessageId
            )
              throw new Error('Host delivery identity changed');
            return {
              recipient,
              unconfirmed: status.confirmation === 'unconfirmed',
              responsePending: status.responsePending,
            };
          }
          const status = await api.teams.getOpenCodeRuntimeDeliveryStatus(
            teamName,
            recipient.physicalMessageId
          );
          return {
            recipient,
            unconfirmed:
              status?.ledgerStatus === 'failed_terminal' &&
              status.reason === 'group_delivery_unconfirmed',
            responsePending: status?.responsePending,
          };
        })
      );
      if (!active) return;
      const expired = Date.now() >= deadline;
      setUnconfirmed(
        statuses.flatMap((result, index) => {
          if (result.status === 'rejected')
            return host && expired ? [pending[index].memberName] : [];
          return result.value.unconfirmed ||
            (host && expired && result.value.responsePending !== false)
            ? [result.value.recipient.memberName]
            : [];
        })
      );
      if (
        Date.now() < deadline &&
        statuses.some(
          (result) => result.status === 'rejected' || result.value.responsePending !== false
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
