import type { RuntimeMessageDeliveryPort } from '../ports/RuntimeDeliveryPort';

export interface DeliverRuntimeMessageCommand<Input = unknown> {
  input: Input;
}

export class DeliverRuntimeMessageUseCase<Input = unknown, Acknowledgement = unknown> {
  constructor(
    private readonly runtimeDelivery: RuntimeMessageDeliveryPort<Input, Acknowledgement>
  ) {}

  execute(command: DeliverRuntimeMessageCommand<Input>): Promise<Acknowledgement> {
    return this.runtimeDelivery.deliverRuntimeMessage(command.input);
  }
}
