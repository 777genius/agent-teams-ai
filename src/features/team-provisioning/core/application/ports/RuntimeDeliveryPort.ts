import type {
  RuntimeDeliveryStatus,
  RuntimeMessageDeliveryAck,
} from '../../../contracts/runtime-delivery';

export interface RuntimeMessageDeliveryPort {
  deliverRuntimeMessage(raw: unknown): Promise<RuntimeMessageDeliveryAck>;
}

export interface RuntimeDeliveryStatusPort {
  getRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<RuntimeDeliveryStatus | null>;
}

export interface RuntimeDeliveryPort
  extends RuntimeMessageDeliveryPort, RuntimeDeliveryStatusPort {}
