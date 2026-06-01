# Codex Auth

Codex subscription execution uses a local encrypted session store for backend
workers. The backend process can decrypt the session at runtime, refresh it via
Codex, and write the updated generation back to the local store.

Do not commit `auth.json` or decrypted session files. Bootstrap from an existing
local Codex login and store only encrypted runtime state under the configured
state directory.
