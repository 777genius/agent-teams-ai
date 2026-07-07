export type WebhookRunEventFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
