# Owner anchor library build contract

`build-owner-anchor-library.mjs` packages the existing Product process-ownership implementation for
the hosted Owner. It does not create another supervisor, state machine, RPC boundary, signature, or
admission decision.

## Build

Run from a lockfile-installed Product checkout on the final Linux build target:

```sh
node scripts/hosted-web/build-owner-anchor-library.mjs \
  --output /absolute/caller-owned/new-directory \
  --cc /absolute/path/to/the/image-pinned-c-compiler
```

Both arguments are required. The output path must be absolute, its parent must already exist, and
the parent must be owned by the caller's effective user. The leaf must not exist. The builder creates
that leaf exclusively and never removes or replaces an existing directory. A failed build
deliberately leaves its newly-created partial directory for the caller to inspect and dispose.

The TypeScript closure is emitted with the repository's installed, lockfile-pinned `typescript`
package. The builder rewrites internal aliases to relative ESM paths and walks both runtime and type
graphs. It fails if the runtime graph contains anything except packaged relative modules and its
declared `node:` builtins. The narrow `TeamProviderId` declaration is derived from the authoritative
source type so the output does not drag desktop or Electron declarations into Owner.

The C invocation uses the explicitly supplied compiler and the production
`src/features/team-runtime-control/main/native/process-anchor/process_anchor.c` plus its production
header. It does not use the phase-0 spike. Compiler path, binary hash, version, target tuple, flags,
fixed non-secret compiler environment, source hashes, package-tool hashes, and every payload hash
are recorded in `provenance.json`.

## Consume

Install or copy the complete generated directory without changing its internal paths. Import the
package root for `AnchorProcessSupervisorAdapter`, `NodeAnchorLaunchMaterializer`,
`NodeAnchorSpawner`, process ownership store ports/states, process supervisor contracts, and their
parsers. Import `@agent-teams/owner-anchor-library/native-artifact` and await
`verifyOwnerAnchorNativeArtifact()` before passing the returned path to `NodeAnchorSpawner`.

The package has no external runtime package dependency. Its only runtime imports are the Node
builtins listed in provenance. Its TypeScript declarations require only the declared `@types/node`
peer for Node builtin types; they do not require the Product workspace, Electron, or the Product
storage database. Owner must provide its own implementation of `ProcessOwnershipStorePort` over
Owner's existing durable process store.

## Linux and admission boundary

The native output is an ELF for the build host's `x86_64` or `aarch64` architecture. If it has a
dynamic ELF interpreter, it is applicable only where that interpreter and an ABI-compatible libc
are present. Build inside the final target image (or an exactly pinned compatible build image); do
not assume a glibc-built ELF runs on musl, or the reverse. The exact interpreter is recorded in
provenance and in the native-artifact binding.

`provenance.json` is hash evidence only. Its own bytes must be pinned by the existing admitted image
manifest. It is not signed, does not self-assert trust, and does not authorize launch or release.
