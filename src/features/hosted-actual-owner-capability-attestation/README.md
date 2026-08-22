# Hosted actual-owner capability attestation

This product-owned slice defines the closed v1 capability-attestation schema and its canonical JSON
codec. The main-process entrypoint creates a per-run ephemeral Ed25519 issuer. Its returned public
descriptor is intentionally narrow enough for a future authenticated one-use descriptor bootstrap;
this feature does not deliver that descriptor or enable an external writer.

Create one issuer per run/session, issue only from already-verified provenance inputs, and call
`dispose()` on every owner-loss and shutdown path. The private seed and key object are neither part
of the descriptor nor enumerable/serializable. Disposal drops the key object and overwrites the
retained seed as a best-effort process-memory cleanup.
