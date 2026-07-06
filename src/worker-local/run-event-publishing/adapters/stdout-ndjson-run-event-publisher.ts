import type {
  RunEvent,
  RunEventPublisherPort,
} from "@vioxen/subscription-runtime/worker-core";

export type StdoutRunEventPublisherOptions = {
  readonly write?: (chunk: string) => void;
};

export class StdoutNdjsonRunEventPublisher implements RunEventPublisherPort {
  private readonly write: (chunk: string) => void;

  constructor(options: StdoutRunEventPublisherOptions = {}) {
    this.write = options.write ?? ((chunk) => process.stdout.write(chunk));
  }

  async publish(events: readonly RunEvent[]): Promise<void> {
    for (const event of events) {
      this.write(`${JSON.stringify(event)}\n`);
    }
  }
}
