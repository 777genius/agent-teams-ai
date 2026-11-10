# Agent Teams authentication and account requirements

## Do I need to sign in?

**No Agent Teams account, website login, payment, credit card or product-specific OAuth flow is required** to download and run the free, open-source desktop app.

- **Install:** https://agentteams.live/download/
- **First run:** https://docs.agentteams.live/guide/installation
- **Free model:** an available no-login OpenCode model can be used from the desktop UI; actual availability depends on the runtime/provider.
- **Optional model providers:** Claude Code, Codex and other runtimes may separately require their **own** API keys, subscriptions or native sign-in. Complete those steps with the provider, not on agentteams.live.

## Can an external AI agent connect?

The running desktop app exposes a **local** MCP endpoint, discoverable under **Settings → External agent connection**. Local Claude Code and Codex clients can use the app-generated command under **Manage teams with a prompt** to register the endpoint and verify the app identity before modifying drafts.

- **Connection instructions:** https://docs.agentteams.live/guide/connect-external-agent
- **MCP overview:** https://docs.agentteams.live/guide/mcp-integration
- **Privacy:** https://docs.agentteams.live/reference/privacy-local-data

This site does **not** offer a public hosted REST API, OAuth authorization server, signup endpoint or internet-accessible MCP server. A cloud-only agent cannot call a local loopback endpoint without a local executor.

Do not publish local connection details, access tokens or provider credentials.
