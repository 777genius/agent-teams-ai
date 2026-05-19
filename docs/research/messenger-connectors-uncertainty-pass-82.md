# Messenger Connectors Uncertainty Pass 82

Focus:

Does the local UI/API plan stay aligned with the feature architecture standard and the decision to use the existing HTTP server, or do old IPC-primary notes still compete with it?

Finding:

The top architecture decision already says the existing Fastify `HttpServer` is the HTTP-first local app API boundary. Lower implementation notes still said to register messenger IPC and add connect/disconnect IPC, which read like a second primary UI API. That creates contract drift and weakens future browser/web portability.

Current local API rule:

```text
renderer/browser UI
-> shared contracts/api DTOs
-> HTTP client over existing local Fastify HttpServer
-> registerMessengerConnectorsHttp input adapter
-> feature facade
-> core use cases
```

Electron preload rule:

```text
preload / IPC
-> shell-only helpers
-> open local settings URL, reveal local logs, desktop-only compatibility bridges
```

Do not put normal messenger data/control operations behind IPC as the primary path.

Security implication:

The existing `HttpServer` owns global CORS behavior, but messenger routes are sensitive because they can connect bots, rotate credentials, approve sends and repair route bindings. Protected messenger routes therefore need a feature-local Fastify hook/plugin:

```text
Host allowlist
Origin check
local session cookie
CSRF token for cookie-auth mutations
redacted request logging
zod/request-schema validation
```

This hook runs before the HTTP adapter calls the feature facade. Core still does not import Fastify, Electron or renderer state.

Route registration shape:

```text
src/features/messenger-connectors/main/adapters/input/http/registerMessengerConnectorsHttp.ts
src/features/messenger-connectors/main/adapters/input/http/messengerLocalHttpSecurity.ts
src/features/messenger-connectors/contracts/api.ts
src/features/messenger-connectors/renderer/adapters/createMessengerConnectorsClient.ts
```

Top 3 implementation options:

1. HTTP-first feature routes with feature-local security hooks - 🎯 9   🛡️ 9   🧠 6, about `900-1800` LOC.
   - Recommended.
   - Best fit for browser/web path and avoids IPC/HTTP contract drift.
2. IPC primary plus HTTP mirror - 🎯 7   🛡️ 7   🧠 7, about `1400-2600` LOC.
   - Safer if HTTP auth is delayed.
   - Creates duplicate contracts and tests.
3. IPC-only for MVP - 🎯 5   🛡️ 6   🧠 4, about `600-1200` LOC.
   - Faster desktop demo.
   - Conflicts with the web-scaling goal and the existing local API decision.

Verdict:

Use HTTP-first local routes on the existing `HttpServer`, with feature-local security hooks. Keep preload/IPC shell-only.
