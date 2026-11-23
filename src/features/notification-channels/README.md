# Notification Channels

Outbound notification routing. Not the Attention Inbox and not two-way messaging.

- Contracts: safe DTOs, IPC/HTTP routes, allowed providers and event types.
- Domain: validation, outbound allowlist, metadata-only content policy.
- Application: save/delete/test/dispatch; ports for metadata, encryption and delivery.
- Main adapters: **dedicated** encrypted ApiKeyService instance under appData
  (not the generic renderer-accessible API-key store), JSON metadata
  with owner-only permissions, @thinwrap/notifications transport, bounded HTTPS requests,
  same-origin HTTP mutation guard, and IPC handlers.
- Renderer: portable React settings UI through the shared api abstraction.

External delivery is opt-in. No offline queue or background daemon; when the host
process stops, external delivery stops. OS toasts and notification history are not
changed. Failed deliveries are not retried, avoiding unsolicited duplicates.
Only fixed event labels are sent: **no raw agent messages or task descriptions**.

For browser/server mode, credential mutations require loopback Host and a same-origin
Origin header. This is local-only configuration, not a public multi-user API.
Webhook URLs are credentials and are never returned by the list endpoint.

Notification credentials live in the isolated `notification-channel-credentials/api-keys.json` file. The generic API-keys IPC/API only uses its separate default vault and cannot list, lookup, update or delete these credentials. No credential migration from the pre-merge research prototype is attempted.
