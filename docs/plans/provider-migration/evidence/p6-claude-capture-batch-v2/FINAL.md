# Final D batch candidate and scoped native proof

Select only the final exact tested archive:

`/private/tmp/TEST-claude-capture-batch-pack-final-6QRLVC/retained/agent-teams-provider-implementations-0.0.0.tgz`

- SHA256: `6c57a7bb69a5213b75b9d0393c4d2aec0b75096ae147fc65ccae0fc37d190d1a`
- Integrity: `sha512-a+vYHK0xRY3Q5UZaOSWQ7AJK2nJ83Sfv6PNKMw4sIMbR/sdo0yEjLT4cx08jI54b1rxIDQPGMeUSL1U+6NLXZQ==`
- Frozen D source: `/private/tmp/TEST-claude-capture-batch-source-v3/receipt.json`; combined six-file delta from v1 capture SHA256 `b285c9c6e70bb7f0366aa53d09a419e6f2060c2141af9c057b3ca8f8f77f2586`.
- `all184-generated-source-comparison-final.json`: every generated file's SHA and its source SHA. All 92 source files stayed unchanged during canonical build/qualification; all 184 dist files match the exact tar. This file SHA256 is `ffba06364bc75ac884fcf0f5f2a4e332fe7c945cbb4d27f7c443869457a7050b`.
- `producer-qualification-final/`: canonical build, typed public consumer, runtime public facade/private-path rejection, synthetic consumer lifecycle, source snapshot and full 187-member archive review. Manifest/README/LICENSE and dependency pins are unchanged. There are seven capture-related generated changes vs `6f18...` and only `capture.js` changes beyond the intermediate `ed7305...` candidate.

Canonical producer job `0e57e01ae23488fdd0af188cac16dca3` exited zero. Actual native job `1b392af0b5beddac140f8b4480a07a20` exited zero; its exact reference is `attempt3-job.json`. The complete final private TEST root is retained in `final-test-root/`, with its exact harness source in `final-native-source/` and D source in `frozen-D-source-v3/`.

Original native receipt SHA256: `ab256ae61d720ecf02f488dacd93b7422dd3d042153e534fa0be71207bc0e99d`.

The actual before barrier held 501 ms. The actual batch callback held 500 ms with one model request throughout, and included the configured mapped post-tool hook's late second file. Failed Bash retained native/capture `failed`; successful Write and Edit both reached validated batches. Six batch observations covered all foreground calls, including the two-tool group; the sole D gap was the requested background Bash, bound to its original input/operation. Its later background follow-up also produced a session-scoped unknown result, retained as an unsupported background profile.

An independent PostToolBatch hook wrote a later file after the D batch snapshot. That remains GAP, alongside external writer ownership, nested projects and overlapping parallel attribution. Overall M13 remains GAP; only the stated foreground mapped post-tool-use boundary is qualified. No permission/input/output behavior or Session SPI changed. The captured native child PID 58306 exited zero; D close confirmed cleanup and the PID was physically absent.

Earlier attempts are preserved rather than overwritten:

- `producer-qualification/`, `failed-attempt1-root/`, `failed-attempt1-source/`: first batch candidate rejected native synthetic `hook-UUID` transport IDs; actual wire drove the rejecting regression and fix.
- `producer-qualification-fixed/`, `retained-test-root/`, `source/`, `frozen-D-source-v2/`: intermediate `ed7305...` passed the batch barrier but conservatively gapped Edit because native JSON reordered its default `replace_all` key. Actual-shape regression and canonical fingerprint fix followed. The final candidate preserves retained input values/order and compares semantic JSON object identity.

All 64 Claude adapter tests, strict package types and scoped lint pass. FMS remained at zero diagnostics and CMS at its existing pending legacy boundary. Broad build-routing/full CI and Node26 checks are not claimed. No frontend install, frontend/Host build, Host source edit or commit was performed. Read-only next-slice guidance is in `host-observe-batch-next-slice.md`.
