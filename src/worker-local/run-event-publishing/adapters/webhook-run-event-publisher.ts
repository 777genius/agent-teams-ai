import type {
  RunEvent,
  RunEventPublisherPort,
} from "@vioxen/subscription-runtime/worker-core";
import type { WebhookRunEventFetch } from "../ports/run-event-fetch";

export type { WebhookRunEventFetch } from "../ports/run-event-fetch";

export type WebhookRunEventPublisherOptions = {
  readonly endpointUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly fetch?: WebhookRunEventFetch;
};

export class WebhookRunEventPublisher implements RunEventPublisherPort {
  private readonly endpointUrl: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: WebhookRunEventFetch;

  constructor(options: WebhookRunEventPublisherOptions) {
    if (!options.endpointUrl.trim()) {
      throw new Error("webhook_run_event_endpoint_url_required");
    }
    this.endpointUrl = options.endpointUrl;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async publish(events: readonly RunEvent[]): Promise<void> {
    if (events.length === 0) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpointUrl, {
        method: "POST",
        headers: {
          ...this.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          events,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`webhook_run_event_publish_failed:${response.status}`);
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error("webhook_run_event_publish_timeout");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
