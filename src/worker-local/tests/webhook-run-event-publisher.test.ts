import { describe, expect, it } from "vitest";

import {
  RunEventProviderKind,
  RunEventType,
  makeRunEvent,
} from "@vioxen/subscription-runtime/worker-core";
import { WebhookRunEventPublisher, type WebhookRunEventFetch } from "../index";

describe("WebhookRunEventPublisher", () => {
  it("posts safe run event batches to the configured endpoint", async () => {
    const calls: { readonly input: string | URL; readonly init?: RequestInit }[] = [];
    const fetchImpl: WebhookRunEventFetch = async (input, init) => {
      calls.push({
        input,
        ...(init === undefined ? {} : { init }),
      });
      return new Response(null, { status: 204 });
    };
    const publisher = new WebhookRunEventPublisher({
      endpointUrl: "https://orchestrator.example.test/events",
      headers: {
        "x-consumer": "test",
      },
      fetch: fetchImpl,
    });

    await publisher.publish([
      makeRunEvent({
        runId: "run-a",
        type: RunEventType.Completed,
        occurredAt: "2026-07-02T00:00:00.000Z",
        source: {
          providerKind: RunEventProviderKind.Codex,
        },
        payload: {
          apiKey: "secret",
          safe: "visible",
        },
      }),
    ]);

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://orchestrator.example.test/events");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-consumer": "test",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      schemaVersion: 1,
      events: [
        {
          runId: "run-a",
          type: "run.completed",
          payload: {
            apiKey: "<redacted>",
            safe: "visible",
          },
        },
      ],
    });
  });

  it("does not call the webhook for empty event batches", async () => {
    const calls: RequestInit[] = [];
    const publisher = new WebhookRunEventPublisher({
      endpointUrl: "https://orchestrator.example.test/events",
      fetch: async (_input, init) => {
        calls.push(init ?? {});
        return new Response(null, { status: 204 });
      },
    });

    await publisher.publish([]);

    expect(calls).toHaveLength(0);
  });

  it("fails on non-2xx responses without exposing response bodies", async () => {
    const publisher = new WebhookRunEventPublisher({
      endpointUrl: "https://orchestrator.example.test/events",
      fetch: async () => new Response("downstream secret body", { status: 500 }),
    });

    await expect(publisher.publish([event()]))
      .rejects.toThrow("webhook_run_event_publish_failed:500");
  });

  it("fails with a timeout when the webhook does not respond", async () => {
    const publisher = new WebhookRunEventPublisher({
      endpointUrl: "https://orchestrator.example.test/events",
      timeoutMs: 1,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });

    await expect(publisher.publish([event()]))
      .rejects.toThrow("webhook_run_event_publish_timeout");
  });
});

function event() {
  return makeRunEvent({
    runId: "run-a",
    type: RunEventType.ProgressUpdated,
    occurredAt: "2026-07-02T00:00:00.000Z",
    source: {
      providerKind: RunEventProviderKind.Codex,
    },
  });
}
