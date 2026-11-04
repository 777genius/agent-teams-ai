# Local HTTP access

Each API and MCP HTTP listener generates a separate access key when it starts. Restarting a listener or switching the desktop profile retires its previous key. Keys are never accepted in URLs or exposed by connection discovery.

In the desktop app, enable the HTTP server in Settings, copy its browser URL and copy the access key separately. Enter the key on the browser connection screen. The Electron app itself continues to use IPC and requires no browser login.

Standalone and Docker store an owner-only authority descriptor. Startup logs identify the token-free `team-control-api.json` reference. A local operator can read that reference's `descriptorPath`, then read the descriptor's `token`. Supply the key to the browser connection screen or an `Authorization: Bearer ...` HTTP header. Keep the descriptor private; never paste it into a prompt, URL, command argument or shared log.

`AGENT_TEAMS_HTTP_AUTH_DIR` selects a standalone credential directory. Its existing ancestors must be owned and safe, and the final directory and files must be private. The old proposed `AGENT_TEAMS_HTTP_AUTH_TOKEN` setting is unsupported because a fixed key would survive listener replacement.

Browser requests use exact origins. Set `CORS_ORIGIN` to a comma-separated list of full trusted origins, including ports, when a separate renderer origin is required. Wildcards and `Origin: null` are rejected. CORS configuration does not change the listener's Host authority. For LAN or reverse-proxy access, explicitly set `AGENT_TEAMS_HTTP_PUBLIC_ORIGIN` to the exact externally visible origin, for example `https://teams.example.test` or `http://192.168.1.20:3456`. This separately authorizes that Host and origin; forwarded headers never select authority. Docker access at `http://localhost:3456` works with the default loopback authority.

Managed OpenCode clients require a runtime supporting authenticated MCP HTTP headers. An older runtime is rejected before launch with upgrade guidance. Cursor and native provider connections receive credentials through private configuration or child environment; discovery URLs contain no key. Stdio MCP does not require an HTTP credential for its transport.
