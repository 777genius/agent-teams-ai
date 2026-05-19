# Messenger Connectors - Uncertainty Pass 52

Date: 2026-04-30
Scope: local API boundary, existing Fastify server, Electron independence, future web scaling

## Decision

Use the existing local Fastify `HttpServer` as the HTTP-first local app API boundary for messenger connectors.

Do not create a second local daemon/server for messenger connectors in MVP.

Do not make the core feature depend on Electron, Fastify, IPC, Telegram SDKs, renderer state or concrete app services.

## Final Shape

```text
messenger-connectors core
  domain
  application use-cases
  ports

main adapters
  existing Fastify HttpServer route adapter
  Electron IPC adapter for desktop-only bridge/start-stop if needed
  MCP adapter for agent tools
  Telegram official relay client
  Telegram own-bot polling client
  local store adapters
  credential vault adapter

renderer
  calls one API contract shape
  Electron mode can use preload
  browser mode can use HTTP client
```

## Protocol Split

Use REST/SSE for app UI and local control:

```text
renderer/browser UI -> local Fastify REST/SSE -> feature facade -> use-cases
```

Use MCP for agent/runtime tools:

```text
lead/teammate runtime -> MCP message_send and related tools -> local stores/use-cases
```

Use backend relay protocol for official shared bot:

```text
Telegram -> cloud relay webhook
cloud relay -> desktop main-process SSE/HTTP streaming claim
desktop -> cloud relay REST ACK/send
```

Use direct Telegram polling only for own-bot mode:

```text
desktop main process -> Telegram getUpdates/sendMessage
```

Important:

```text
The existing local HttpServer is not the public Telegram webhook server.
It remains local app API infrastructure.
```

## Why Existing HttpServer Is The Right Local Boundary

Local repo already has:

- Fastify `HttpServer` in main process.
- Bind to `127.0.0.1` by default.
- Existing `/api/events` SSE route for browser-mode UI events.
- Existing `HttpAPIClient` fallback for browser mode.
- Feature-level HTTP adapter precedent in `recent-projects`.
- Standalone mode where the renderer can run without Electron.

This means messenger can become web-ready without duplicating IPC logic:

```text
contracts/api DTOs
-> feature facade
-> HTTP adapter
-> renderer HTTP client
```

Electron IPC remains useful for desktop-only operations:

- start/stop local server
- file picker
- OS dialogs
- native notifications if needed
- narrow preload bridge for Electron-only shell actions

## Localhost Security Minimum

Because any website can attempt requests to `localhost`, localhost-only is not enough for mutating messenger routes.

Required minimum:

```text
bind only 127.0.0.1 by default
Host allowlist: 127.0.0.1, localhost
strict Origin check for /api/*
local session auth for protected /api/*
CSRF check for cookie-auth mutating requests
no CORS_ORIGIN='*' for sensitive desktop API routes
redact tokens, message text and provider payloads in logs
per-route permission classes
```

Recommended browser login:

```text
Electron opens:
  http://127.0.0.1:<port>/auth/local?code=<one-time-code>

Server:
  validates code
  burns code
  sets HttpOnly SameSite=Strict local session cookie
  redirects to /
```

For native tools or CLI clients:

```text
Authorization: Bearer <local capability token>
```

Do not put long-lived tokens in query strings.

## Route Namespace

Messenger routes should live under a clear protected namespace:

```text
GET  /api/messenger/connections
POST /api/messenger/connections/telegram/official/start
POST /api/messenger/connections/telegram/own-bot/connect
POST /api/messenger/connections/:connectionId/disconnect
GET  /api/messenger/routes
POST /api/messenger/routes/:routeId/repair
GET  /api/messenger/review-queue
POST /api/messenger/review-queue/:id/approve
POST /api/messenger/review-queue/:id/reject
GET  /api/events   event: messenger:changed
```

The HTTP adapter should call a feature facade, not internal stores directly.

## Interface Ownership

Core owns use-case contracts:

```text
ConnectOfficialTelegramUseCase
ConnectOwnTelegramBotUseCase
ListMessengerConnectionsUseCase
ListMessengerRoutesUseCase
ApproveExternalReplyProjectionUseCase
RejectExternalReplyProjectionUseCase
RepairMessengerRouteUseCase
```

Adapters own wire details:

```text
Fastify route schemas
Electron preload shape
MCP tool schemas
Telegram JSON normalization
backend relay JSON
```

This preserves DIP:

```text
use-cases depend on ports
adapters depend on use-cases
core never imports adapters
```

## Top 3 Options

1. Existing `HttpServer` as HTTP-first local API, with session/Origin/Host protection.
   🎯 9   🛡️ 8   🧠 6   Approx 2500-6000 LOC across auth, adapters, UI client and tests.
   Recommended. Best path toward browser UI and future hosted web without duplicate feature logic.

2. Dual mode: IPC primary now, HTTP mirror for browser/standalone.
   🎯 8   🛡️ 8   🧠 7   Approx 3000-7000 LOC.
   Safe migration, but creates duplicate behavior and contract drift risk.

3. New messenger-only local daemon/server.
   🎯 5   🛡️ 8   🧠 8   Approx 4000-8000 LOC.
   Better isolation, but duplicates lifecycle, auth, route registration, logging, shutdown and port management.

## Tests Needed

- Protected messenger mutating route rejects missing session.
- Protected messenger mutating route rejects bad Origin.
- Protected messenger mutating route rejects bad Host.
- One-time local auth code can be used once.
- Session cookie is HttpOnly and SameSite=Strict.
- CSRF required for cookie-auth POST/PUT/PATCH/DELETE.
- Browser HTTP client and Electron preload produce the same DTO shape.
- HTTP adapter cannot import core infrastructure internals directly.
- Core cannot import Electron, Fastify, renderer or Telegram libraries.
- MCP route remains tool-only and does not become provider transport.

## Updated Implementation Sequence

Do early:

1. Add `messenger-connectors/contracts/api.ts`.
2. Add local HTTP security middleware for protected feature routes.
3. Add `registerMessengerConnectorsHttp()`.
4. Add feature facade methods used by HTTP, IPC and tests.
5. Keep Electron IPC minimal and shell-oriented.
6. Add renderer API client against the shared contract shape.

Do not wait until the end to add HTTP security. If mutating messenger routes ship first and auth comes later, tests and UI will normalize an unsafe contract.
