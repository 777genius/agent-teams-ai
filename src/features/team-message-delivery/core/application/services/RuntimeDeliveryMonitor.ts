import type { RuntimeRelayResult } from '../../domain/messageDeliveryModels';
import type {
  DeadlinePort,
  RuntimeDeliveryCompatibilityPort,
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
      compatibility: Pick<
        RuntimeDeliveryCompatibilityPort,
        | 'buildTimeoutRelayResult'
        | 'formatWarning'
        | 'shouldLookupStatusAfterRelay'
        | 'statusToRelayResult'
      >;
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
        if (delivery && !delivery.delivered) {
          this.warn({
            kind: 'late-failure',
            memberName: input.memberName,
            delivery,
          });
        }
      },
      (error: unknown) => {
        if (!timedOut) return;
        this.warn({ kind: 'late-rejection', memberName: input.memberName, error });
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
        return this.dependencies.compatibility.statusToRelayResult(status);
      }
    } catch (error) {
      this.warn({ kind: 'status-lookup-failure', memberName: input.memberName, error });
      return this.dependencies.compatibility.buildTimeoutRelayResult(error);
    }
    return this.dependencies.compatibility.buildTimeoutRelayResult();
  }

  private async enrichBareRelay(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    relay: RuntimeRelayResult;
  }): Promise<RuntimeRelayResult> {
    if (!this.dependencies.compatibility.shouldLookupStatusAfterRelay(input.relay)) {
      return input.relay;
    }
    try {
      const status = await this.dependencies.deadline.withTimeoutValue(
        this.dependencies.messaging.getRuntimeDeliveryStatus(input.teamName, input.messageId),
        RUNTIME_DELIVERY_STATUS_AFTER_UI_TIMEOUT_MS,
        null
      );
      return status ? this.dependencies.compatibility.statusToRelayResult(status) : input.relay;
    } catch (error) {
      this.warn({ kind: 'status-enrichment-failure', memberName: input.memberName, error });
      return input.relay;
    }
  }

  private warn(event: Parameters<RuntimeDeliveryCompatibilityPort['formatWarning']>[0]): void {
    const message = this.dependencies.compatibility.formatWarning(event);
    if (message) this.dependencies.logger.warn(message);
  }
}
