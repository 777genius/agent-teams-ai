import type { RuntimeControlAck } from './RuntimeControlAck';
import type {
  RuntimeBootstrapCheckinCommand,
  RuntimeDeliverMessageCommand,
  RuntimeHeartbeatCommand,
  RuntimePermissionAnswerCommand,
  RuntimeTaskEventCommand,
} from './RuntimeControlCommand';

export const RUNTIME_CONTROL_PROVIDER_IDS = ['opencode', 'subscription'] as const;

export type RuntimeControlProviderId = (typeof RUNTIME_CONTROL_PROVIDER_IDS)[number];

export function isRuntimeControlProviderId(value: unknown): value is RuntimeControlProviderId {
  return value === 'opencode' || value === 'subscription';
}

export interface RuntimeControlProviderHandler {
  readonly providerId: RuntimeControlProviderId;
  recordBootstrapCheckin?(command: RuntimeBootstrapCheckinCommand): Promise<RuntimeControlAck>;
  deliverMessage?(command: RuntimeDeliverMessageCommand): Promise<RuntimeControlAck>;
  recordTaskEvent?(command: RuntimeTaskEventCommand): Promise<RuntimeControlAck>;
  recordHeartbeat?(command: RuntimeHeartbeatCommand): Promise<RuntimeControlAck>;
  answerPermission?(command: RuntimePermissionAnswerCommand): Promise<RuntimeControlAck>;
}
