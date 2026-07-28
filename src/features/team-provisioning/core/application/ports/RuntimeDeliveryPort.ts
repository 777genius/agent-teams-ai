export interface RuntimeMessageDeliveryPort<Input = unknown, Acknowledgement = unknown> {
  deliverRuntimeMessage(input: Input): Promise<Acknowledgement>;
}

export interface RuntimeDeliveryStatusPort<Status = unknown> {
  getRuntimeDeliveryStatus(teamName: string, messageId: string): Promise<Status | null>;
}

export interface RuntimeDeliveryPort<Input = unknown, Acknowledgement = unknown, Status = unknown>
  extends RuntimeMessageDeliveryPort<Input, Acknowledgement>, RuntimeDeliveryStatusPort<Status> {}
