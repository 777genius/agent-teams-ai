# Codex Auth

Codex subscription execution uses a local encrypted session store for backend
workers. The backend process can decrypt the session at runtime, refresh it via
Codex, and write the updated generation back to the local store.

Do not commit `auth.json` or decrypted session files. Bootstrap from an existing
local Codex login and store only encrypted runtime state under the configured
state directory.

For account status, use:

```bash
subscription-runtime-account-status --provider codex
subscription-runtime-account-status --provider codex --probe
```

The default command reads safe `auth.json` identity metadata and cached capacity
signals. `--probe` can detect revoked refresh tokens that a shallow login-status
check may miss, but it can spend provider capacity. See
`docs/account-diagnostics.md`.
