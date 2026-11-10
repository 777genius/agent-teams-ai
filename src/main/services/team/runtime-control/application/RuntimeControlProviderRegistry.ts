import {
  isRuntimeControlProviderId,
  type RuntimeControlProviderHandler,
  type RuntimeControlProviderId,
} from '../domain/RuntimeControlProvider';

export type RuntimeControlProviderOperation =
  | 'recordBootstrapCheckin'
  | 'deliverMessage'
  | 'recordTaskEvent'
  | 'recordHeartbeat'
  | 'answerPermission';

export type RuntimeControlProviderRoutingErrorReason =
  | 'provider_not_registered'
  | 'operation_not_supported';

export class RuntimeControlProviderRoutingError extends Error {
  readonly providerId: RuntimeControlProviderId;
  readonly operation: RuntimeControlProviderOperation;
  readonly reason: RuntimeControlProviderRoutingErrorReason;

  constructor(input: {
    providerId: RuntimeControlProviderId;
    operation: RuntimeControlProviderOperation;
    reason: RuntimeControlProviderRoutingErrorReason;
  }) {
    super(buildRuntimeControlProviderRoutingErrorMessage(input));
    this.name = 'RuntimeControlProviderRoutingError';
    this.providerId = input.providerId;
    this.operation = input.operation;
    this.reason = input.reason;
  }
}

export class RuntimeControlProviderRegistry {
  private readonly handlers = new Map<RuntimeControlProviderId, RuntimeControlProviderHandler>();

  constructor(handlers: readonly RuntimeControlProviderHandler[] = []) {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  register(handler: RuntimeControlProviderHandler): void {
    if (!isRuntimeControlProviderId(handler.providerId)) {
      throw new Error(`Invalid runtime control provider: ${String(handler.providerId)}`);
    }
    if (this.handlers.has(handler.providerId)) {
      throw new Error(`Runtime control provider already registered: ${handler.providerId}`);
    }
    this.handlers.set(handler.providerId, handler);
  }

  get(providerId: RuntimeControlProviderId): RuntimeControlProviderHandler | undefined {
    return this.handlers.get(providerId);
  }

  requireProvider(
    providerId: RuntimeControlProviderId,
    operation: RuntimeControlProviderOperation
  ): RuntimeControlProviderHandler {
    const handler = this.get(providerId);
    if (!handler) {
      throw new RuntimeControlProviderRoutingError({
        providerId,
        operation,
        reason: 'provider_not_registered',
      });
    }
    return handler;
  }

  requireOperation(
    providerId: RuntimeControlProviderId,
    operation: RuntimeControlProviderOperation
  ): RuntimeControlProviderHandler {
    const handler = this.requireProvider(providerId, operation);
    if (typeof handler[operation] !== 'function') {
      throw new RuntimeControlProviderRoutingError({
        providerId,
        operation,
        reason: 'operation_not_supported',
      });
    }
    return handler;
  }

  has(providerId: RuntimeControlProviderId): boolean {
    return this.handlers.has(providerId);
  }

  providers(): RuntimeControlProviderId[] {
    return Array.from(this.handlers.keys());
  }
}

function buildRuntimeControlProviderRoutingErrorMessage(input: {
  providerId: RuntimeControlProviderId;
  operation: RuntimeControlProviderOperation;
  reason: RuntimeControlProviderRoutingErrorReason;
}): string {
  if (input.reason === 'provider_not_registered') {
    return `Runtime control provider is not registered: ${input.providerId}`;
  }
  return `Runtime control provider ${input.providerId} does not support ${input.operation}`;
}
