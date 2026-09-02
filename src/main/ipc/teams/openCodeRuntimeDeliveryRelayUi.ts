import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { withTimeoutValue } from './withTimeoutValue';

import type {
  TeamMessagingApi,
  TeamOpenCodeMemberInboxRelayResult,
} from '../../services/team/contracts/TeamProvisioningApis';
import type { OpenCodeRuntimeDeliveryStatus } from '@shared/types';

const logger = createLogger('IPC:teams');
// Runtime relay continues in the background after this race; keep sendMessage IPC off the
// 25s OpenCode turn-settled guard while still giving prompt acceptance/reconcile time.
const OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_MS = 6_000;
const OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS = 1_000;
const OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON =
  'opencode_runtime_delivery_ui_timeout_pending';

type OpenCodeMemberInboxRelayResult = TeamOpenCodeMemberInboxRelayResult;
type OpenCodeMemberInboxDelivery = NonNullable<OpenCodeMemberInboxRelayResult['lastDelivery']>;

export async function waitForOpenCodeRuntimeRelayForUi(input: {
  messaging: TeamMessagingApi;
  teamName: string;
  memberName: string;
  messageId: string;
  relayPromise: Promise<OpenCodeMemberInboxRelayResult>;
  timeoutMs?: number;
}): Promise<OpenCodeMemberInboxRelayResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  void input.relayPromise.then(
    (relay) => {
      if (!timedOut) return;
      const delivery = relay.lastDelivery;
      if (delivery && !delivery.delivered && delivery.reason !== 'recipient_is_not_opencode') {
        logger.warn(
          `OpenCode runtime delivery after sendMessage completed after UI timeout for teammate "${input.memberName}" with failure: ${
            delivery.reason ?? 'unknown error'
          }`
        );
      }
    },
    (error: unknown) => {
      if (!timedOut) return;
      logger.warn(
        `OpenCode runtime delivery after sendMessage rejected after UI timeout for teammate "${input.memberName}": ${getErrorMessage(error)}`
      );
    }
  );

  try {
    const outcome = await Promise.race<
      { kind: 'relay'; relay: OpenCodeMemberInboxRelayResult } | { kind: 'timeout' }
    >([
      input.relayPromise.then((relay) => ({ kind: 'relay' as const, relay })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve({ kind: 'timeout' });
        }, input.timeoutMs ?? OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);

    if (outcome.kind === 'relay') {
      return await enrichBareOpenCodeRuntimeRelayResultForUi({
        ...input,
        relay: outcome.relay,
      });
    }

    try {
      const status = await withTimeoutValue(
        input.messaging.getOpenCodeRuntimeDeliveryStatus(input.teamName, input.messageId),
        OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
        null
      );
      if (status) {
        return openCodeRuntimeDeliveryStatusToRelayResult(status);
      }
    } catch (error) {
      const reason = getErrorMessage(error);
      logger.warn(
        `OpenCode runtime delivery status after UI timeout failed for teammate "${input.memberName}": ${reason}`
      );
      return buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult([
        `${OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON}: status lookup failed: ${reason}`,
      ]);
    }

    return buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function enrichBareOpenCodeRuntimeRelayResultForUi(input: {
  messaging: TeamMessagingApi;
  teamName: string;
  memberName: string;
  messageId: string;
  relay: OpenCodeMemberInboxRelayResult;
}): Promise<OpenCodeMemberInboxRelayResult> {
  if (!shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay(input.relay)) {
    return input.relay;
  }

  try {
    const status = await withTimeoutValue(
      input.messaging.getOpenCodeRuntimeDeliveryStatus(input.teamName, input.messageId),
      OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
      null
    );
    return status ? openCodeRuntimeDeliveryStatusToRelayResult(status) : input.relay;
  } catch (error) {
    logger.warn(
      `OpenCode runtime delivery status enrichment failed for teammate "${input.memberName}": ${getErrorMessage(error)}`
    );
    return input.relay;
  }
}

function shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay(
  relay: OpenCodeMemberInboxRelayResult
): boolean {
  const delivery = relay.lastDelivery;
  if (!delivery?.delivered) {
    return false;
  }
  return (
    typeof delivery.accepted !== 'boolean' &&
    typeof delivery.responsePending !== 'boolean' &&
    !delivery.responseState &&
    !delivery.ledgerStatus &&
    !delivery.ledgerRecordId &&
    !delivery.laneId &&
    !delivery.userVisibleImpact
  );
}

function openCodeRuntimeDeliveryStatusToRelayResult(
  status: OpenCodeRuntimeDeliveryStatus
): OpenCodeMemberInboxRelayResult {
  const lastDelivery: OpenCodeMemberInboxDelivery = {
    delivered: status.delivered,
    ...(typeof status.accepted === 'boolean' ? { accepted: status.accepted } : {}),
    ...(typeof status.responsePending === 'boolean'
      ? { responsePending: status.responsePending }
      : {}),
    ...(typeof status.acceptanceUnknown === 'boolean'
      ? { acceptanceUnknown: status.acceptanceUnknown }
      : {}),
    ...(status.responseState ? { responseState: status.responseState } : {}),
    ...(status.ledgerStatus ? { ledgerStatus: status.ledgerStatus } : {}),
    ...(status.visibleReplyMessageId
      ? { visibleReplyMessageId: status.visibleReplyMessageId }
      : {}),
    ...(status.visibleReplyCorrelation
      ? { visibleReplyCorrelation: status.visibleReplyCorrelation }
      : {}),
    ...(status.ledgerRecordId ? { ledgerRecordId: status.ledgerRecordId } : {}),
    ...(status.laneId ? { laneId: status.laneId } : {}),
    ...(status.queuedBehindMessageId
      ? { queuedBehindMessageId: status.queuedBehindMessageId }
      : {}),
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.diagnostics ? { diagnostics: status.diagnostics } : {}),
    ...(shouldPreserveOpenCodeRuntimeDeliveryStatusImpact(status)
      ? { userVisibleImpact: status.userVisibleImpact }
      : {}),
  };
  return {
    relayed: 0,
    attempted: 1,
    delivered: status.delivered && status.responsePending !== true ? 1 : 0,
    failed: status.delivered ? 0 : 1,
    lastDelivery,
    diagnostics: status.diagnostics,
  };
}

function shouldPreserveOpenCodeRuntimeDeliveryStatusImpact(
  status: OpenCodeRuntimeDeliveryStatus
): boolean {
  if (!status.userVisibleImpact) {
    return false;
  }
  if (
    status.userVisibleImpact.state === 'none' &&
    (status.responsePending === true ||
      status.acceptanceUnknown === true ||
      Boolean(status.queuedBehindMessageId))
  ) {
    return false;
  }
  return true;
}

function buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult(
  extraDiagnostics: string[] = []
): OpenCodeMemberInboxRelayResult {
  const diagnostics = [OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON, ...extraDiagnostics];
  return {
    relayed: 0,
    attempted: 1,
    delivered: 0,
    failed: 1,
    lastDelivery: {
      delivered: true,
      accepted: false,
      responsePending: true,
      acceptanceUnknown: true,
      responseState: 'not_observed',
      reason: OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON,
      diagnostics,
    },
  };
}
