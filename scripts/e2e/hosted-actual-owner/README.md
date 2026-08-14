# Hosted actual-owner E2E harness

This is a manual, source-only, fail-closed acceptance harness. It never supplies a fake runtime or
an in-memory backend. Run it only after the product approval publisher/UI and the orchestrator
acceptance entry are integrated at exact clean commits.

Create two private (`0700`) directories outside every user project: one sandbox parent and one
evidence parent. Copy the unintegrated manifest fixture to a private (`0600`) canonical path, replace
every placeholder, and change the three integration values to `integrated` only when those seams are
real. The OpenCode executable must be the exact release candidate identified by both its full source
commit and SHA-256; its release manifest must bind that commit, digest, and byte size.
The product process entry in the private integration manifest must likewise name a canonical exact
executable and its SHA-256. A separate product release manifest must bind those bytes and size to
the same full product commit supplied on the command line. The manifest may use only the shared
`${SANDBOX_ROOT}`, `${PRODUCT_ROOT}`, `${ORCHESTRATOR_ROOT}`, and `${OPENCODE_EXECUTABLE}` tokens.
The harness expands them only through inode-bound runtime descriptors.

Both candidate executables are copied through verified descriptors into private `0500` staged
files. Their descriptors remain open without being inherited as fixed-number child FDs, and Linux
`/proc/<pid>/exe` device, inode, and digest must match before readiness. The orchestrator launcher
and acceptance entry are likewise copied to immutable private staged paths, kept descriptor-bound,
and matched byte-for-byte to their exact Git blobs. Scripts are never launched through
`/proc/self/fd/*`. Sandbox and evidence roots must be disjoint from both repositories.

From a clean product checkout at the exact product commit, invoke:

```sh
node --import tsx scripts/e2e/hosted-actual-owner/run.ts \
  --product-root /absolute/clean/product \
  --product-ref 0000000000000000000000000000000000000000 \
  --product-release-manifest /absolute/candidate/product-release-manifest.json \
  --orchestrator-root /absolute/clean/orchestrator \
  --orchestrator-ref 0000000000000000000000000000000000000000 \
  --orchestrator-source-launcher /absolute/clean/orchestrator/cli-source \
  --orchestrator-acceptance-entry /absolute/clean/orchestrator/scripts/e2e/hosted-actual-owner-owner.ts \
  --opencode-executable /absolute/candidate/opencode \
  --opencode-sha256 0000000000000000000000000000000000000000000000000000000000000000 \
  --opencode-source-ref 0000000000000000000000000000000000000000 \
  --opencode-release-manifest /absolute/candidate/release-manifest.json \
  --integration-manifest /absolute/private/integration.json \
  --sandbox-parent /absolute/private/sandboxes \
  --evidence-root /absolute/private/evidence
```

The all-zero values above are illustrative, not accepted release identities. The harness rejects
short refs, dirty repositories, a rotated artifact, a built orchestrator launcher, non-private
manifests/directories, unresolved integration state, and unsafe cleanup ownership. It creates a new
marker-bound Git project under the sandbox parent and removes only that exact inode-bound root.
Evidence remains outside the sandbox and records the cleanup proof.

The orchestrator acceptance entry owns the real driver protocol and capture files described by the
runtime manifest. It must use the real OpenCode process and product admission surface, and must
produce durable owner-WAL/product/OpenCode timelines, the conditional POST ledger, protected-effect
ledger, restart/negative matrices, and owner/non-owner browser storage states. Missing or malformed
captures fail the run.
