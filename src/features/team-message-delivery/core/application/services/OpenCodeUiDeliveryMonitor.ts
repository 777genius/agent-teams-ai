import { getErrorMessage } from '@shared/utils/errorHandling';

import {
  buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult,
  OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON,
  openCodeRuntimeDeliveryStatusToRelayResult,
  shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay,
} from '../../domain/openCodeDeliveryProjection';

import type { OpenCodeRelayResult } from '../../domain/messageDeliveryModels';
import type {
  DeadlinePort,
  TeamMessageLoggerPort,
  TeamMessageTransportPort,
} from '../ports/TeamMessageDeliveryPorts';

const OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_MS = 6_000;
const OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS = 1_000;

export class OpenCodeUiDeliveryMonitor {
  constructor(
    private readonly dependencies: {
      messaging: Pick<TeamMessageTransportPort, 'getOpenCodeRuntimeDeliveryStatus'>;
      deadline: DeadlinePort;
      logger: TeamMessageLoggerPort;
    }
  ) {}

  async waitForRelay(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    relayPromise: Promise<OpenCodeRelayResult>;
    timeoutMs?: number;
  }): Promise<OpenCodeRelayResult> {
    let timedOut = false;
    void input.relayPromise.then(
      (relay) => {
        if (!timedOut) return;
        const delivery = relay.lastDelivery;
        if (delivery && !delivery.delivered && delivery.reason !== 'recipient_is_not_opencode') {
          this.dependencies.logger.warn(
            `OpenCode runtime delivery after sendMessage completed after UI timeout for teammate "${input.memberName}" with failure: ${
              delivery.reason ?? 'unknown error'
            }`
          );
        }
      },
      (error: unknown) => {
        if (!timedOut) return;
        this.dependencies.logger.warn(
          `OpenCode runtime delivery after sendMessage rejected after UI timeout for teammate "${input.memberName}": ${getErrorMessage(error)}`
        );
      }
    );

    const outcome = await this.dependencies.deadline.raceWithTimeout(
      input.relayPromise,
      input.timeoutMs ?? OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_MS,
      () => {
        timedOut = true;
      }
    );
    if (outcome.kind === 'value') {
      return this.enrichBareRelay({ ...input, relay: outcome.value });
    }

    try {
      const status = await this.dependencies.deadline.withTimeoutValue(
        this.dependencies.messaging.getOpenCodeRuntimeDeliveryStatus(
          input.teamName,
          input.messageId
        ),
        OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
        null
      );
      if (status) return openCodeRuntimeDeliveryStatusToRelayResult(status);
    } catch (error) {
      const reason = getErrorMessage(error);
      this.dependencies.logger.warn(
        `OpenCode runtime delivery status after UI timeout failed for teammate "${input.memberName}": ${reason}`
      );
      return buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult([
        `${OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON}: status lookup failed: ${reason}`,
      ]);
    }
    return buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult();
  }

  private async enrichBareRelay(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    relay: OpenCodeRelayResult;
  }): Promise<OpenCodeRelayResult> {
    if (!shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay(input.relay)) {
      return input.relay;
    }
    try {
      const status = await this.dependencies.deadline.withTimeoutValue(
        this.dependencies.messaging.getOpenCodeRuntimeDeliveryStatus(
          input.teamName,
          input.messageId
        ),
        OPENCODE_RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
        null
      );
      return status ? openCodeRuntimeDeliveryStatusToRelayResult(status) : input.relay;
    } catch (error) {
      this.dependencies.logger.warn(
        `OpenCode runtime delivery status enrichment failed for teammate "${input.memberName}": ${getErrorMessage(error)}`
      );
      return input.relay;
    }
  }
}
