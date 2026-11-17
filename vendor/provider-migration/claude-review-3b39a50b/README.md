# Checked provider archive — 3b39a50b

Immutable source [3b39a50b28319a3e91e0779493f0d64acb98d2e5](https://github.com/agent-teams-ai/old-provider-implementations/commit/3b39a50b28319a3e91e0779493f0d64acb98d2e5), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

This candidate preserves the application's legacy inline /review recipe through the original SDK main input and permission callbacks. It selects only the captured builtin code-review alias review; exact-name custom commands, direct canonical commands, native settings, original input identities and other provider behavior remain unchanged. The private native inventory is preserved, with an adapter-owned compatibility annotation in the observer projection. This is not qualification of the newer SDK fork.

Official [source and packed-consumer checks](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43434455869) passed on Node 24.21.0 and 26.11.1 with pnpm 11.18.0. These exact package bytes come from checked artifact 14043230900. Its archive hash and source receipt were verified; the package also matches the independently retained local packed-consumer bytes.

Provider archive: agent-teams-provider-implementations-0.0.0.tgz, 175080 bytes, SHA-256 f2514f0bec64a2da36511595fe2d6c67d9cbaa6e0da865a65375c2d7c7fe39a2.

The session-contracts archive remains byte-identical to the existing pin, SHA-256 aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db. Existing historical archives are retained.

Qualification is source and packed consumer only. Actual Host permissions, native command execution, Desktop controls and packaged Electron acceptance require their own exact-candidate results.
