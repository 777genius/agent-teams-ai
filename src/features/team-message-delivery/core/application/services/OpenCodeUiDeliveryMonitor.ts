import { getErrorMessage } from '@shared/utils/errorHandling';

import { toOpenCodeRuntimeDeliveryStatus } from '../../../contracts/compatibility/open-code-delivery';
import {
  buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult,
  OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON,
  openCodeRuntimeDeliveryStatusToRelayResult,
  shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay,
} from '../../domain/openCodeDeliveryProjection';

import type { OpenCodeRuntimeDeliveryStatus } from '../../../contracts/compatibility/open-code-delivery';
import type { RuntimeRelayResult } from '../../domain/messageDeliveryModels';
import type {
  DeadlinePort,
  TeamMessageLoggerPort,
  TeamMessageTransportPort,
} from '../ports/TeamMessageDeliveryPorts';

const RUNTIME_DELIVERY_UI_TIMEOUT_MS = 6_000;
const RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS = 1_000;

export class RuntimeDeliveryMonitor {
  constructor(
    private readonly dependencies: {
      messaging: Pick<TeamMessageTransportPort, 'getRuntimeDeliveryStatus'>;
      deadline: DeadlinePort;
      logger: TeamMessageLoggerPort;
    }
  ) {}

  async waitForRelay(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    relayPromise: Promise<RuntimeRelayResult>;
    timeoutMs?: number;
  }): Promise<RuntimeRelayResult> {
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
      input.timeoutMs ?? RUNTIME_DELIVERY_UI_TIMEOUT_MS,
      () => {
        timedOut = true;
      }
    );
    if (outcome.kind === 'value') {
      return this.enrichBareRelay({ ...input, relay: outcome.value });
    }

    try {
      const status = await this.dependencies.deadline.withTimeoutValue(
        this.dependencies.messaging.getRuntimeDeliveryStatus(input.teamName, input.messageId),
        RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
        null
      );
      if (status) {
        return openCodeRuntimeDeliveryStatusToRelayResult(toOpenCodeRuntimeDeliveryStatus(status));
      }
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
    relay: RuntimeRelayResult;
  }): Promise<RuntimeRelayResult> {
    if (!shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay(input.relay)) {
      return input.relay;
    }
    try {
      const status = await this.dependencies.deadline.withTimeoutValue(
        this.dependencies.messaging.getRuntimeDeliveryStatus(input.teamName, input.messageId),
        RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
        null
      );
      return status
        ? openCodeRuntimeDeliveryStatusToRelayResult(toOpenCodeRuntimeDeliveryStatus(status))
        : input.relay;
    } catch (error) {
      this.dependencies.logger.warn(
        `OpenCode runtime delivery status enrichment failed for teammate "${input.memberName}": ${getErrorMessage(error)}`
      );
      return input.relay;
    }
  }
}

/**
 * Compatibility constructor for existing desktop callers. New application
 * composition uses RuntimeDeliveryMonitor.
 */
export class OpenCodeUiDeliveryMonitor extends RuntimeDeliveryMonitor {
  constructor(dependencies: {
    messaging: {
      getOpenCodeRuntimeDeliveryStatus(
        teamName: string,
        messageId: string
      ): Promise<OpenCodeRuntimeDeliveryStatus | null>;
    };
    deadline: DeadlinePort;
    logger: TeamMessageLoggerPort;
  }) {
    super({
      messaging: {
        getRuntimeDeliveryStatus: (teamName, messageId) =>
          dependencies.messaging.getOpenCodeRuntimeDeliveryStatus(teamName, messageId),
      },
      deadline: dependencies.deadline,
      logger: dependencies.logger,
    });
  }
}
