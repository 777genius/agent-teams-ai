# Sentry artifact privacy checkpoint

This fixture proves that the current-build inventory policy preserves registered
application debug IDs and locators through genuine SDK processing, renderer
Classic IPC and final envelope serialization. It also proves that neighboring
private values keep ordinary redaction. Unknown application locators still fail
closed, including when inventory admission fails. Exact known Node/Electron
runtime pseudo-files retain their filename without receiving artifact trust,
debug IDs or any exception to ordinary privacy redaction.

Run only on an isolated Linux validation host, with the retained producer proof
and a new TEST output directory:

```sh
pnpm exec tsx scripts/e2e/sentry-sdk-envelope/run.mts <retained-producer-proof> <NEW-TEST-output-directory> --preserve
```

The producer bytes and original maps are checked against independent retained
digests. The fixture observes the real Electron/Sentry SDK and unchanged preload
bridge. Its transport is an in-memory callback and implements no HTTP request.
The `worker.cjs` artifact probe currently executes in the main process. It proves
that artifact's mapping contract, not a real worker-thread lifecycle.

The merge checkpoint is the active artifact policy and this transport/privacy
contract, with focused policy tests, canonical typecheck and independent review
of the final code. The inventory producer explicitly marks preload as uncovered;
the policy does not authorize preload artifact rows. Retaining this explicit
coverage boundary is part of the checkpoint.

Full Sentry acceptance remains open and belongs to the subsequent lifecycle and
backend workstream:

- Upload independently reviewed synthetic source/map pairs, then read back a
  backend event with the matching debug IDs and symbolicated source location.
- Capture and prove symbolication from packaged applications on supported
  platforms. General packaged startup smoke does not prove this.
- Prove preload exception coverage before authorizing preload artifacts.
- Prove an actual worker-thread error, SDK initialization, drain and termination.

SDK receipts keep `backendUploadTested: false`, `preloadCoverage: uncovered` and
the platform limitations until those gates are demonstrated. Completing this
checkpoint does not establish release readiness or permission to publish a release.
