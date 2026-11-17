# Checked provider archive — 68dca527

Immutable source [68dca527b779ebb82923f30d7b08441085d8b579](https://github.com/agent-teams-ai/old-provider-implementations/commit/68dca527b779ebb82923f30d7b08441085d8b579), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

This checked candidate adds the original Claude checkpoint-source contract consumed by the existing cold Resume path, retains the captured OpenCode provider fixes, preserves nullable Codex ChatGPT email metadata, and refuses unnegotiated Codex approval kinds. The complete old/new package metadata is identical; the application retains its original dependency and peer graph.

Official [source and packed-consumer checks](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43479531998) passed on Node 24.21.0 and 26.11.1 with pnpm 11.18.0. These exact package bytes were downloaded from checked artifact 14062879890 and verified before repository ingestion. The original receipt.json bytes are retained as checked-artifact-receipt.json; source-receipt.json records the full source, checked artifact and package identities.

Provider archive: agent-teams-provider-implementations-0.0.0.tgz, 177100 bytes, SHA-256 07241cca756e69aa6001df41d6a7408aad5d8ab4c8277f9d70f35d0d66736c73. Checked artifact ZIP: 184234 bytes, SHA-256 854f74916005deb7e5a9f23fed41a99605bfb5757c24c269c0b573ff4374d822.

The session-contracts archive remains byte-identical to the existing canonical pin, SHA-256 aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db. No duplicate contracts archive or historical pin is replaced.

Qualification of this checked artifact remains source and packed consumer only. The dependency's separate native run43479531758 completed53/53 successfully on this source head; that does not qualify the application's Host, Desktop or packaged Electron. Those consumers require their own exact-head installation, archive/dist equality, original native interactions and physical cleanup results.
