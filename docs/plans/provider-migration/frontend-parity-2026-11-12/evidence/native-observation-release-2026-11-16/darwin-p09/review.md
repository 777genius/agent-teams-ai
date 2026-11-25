# Original e1d Darwin V2 P09 refusals

Original run `43813731517`, attempt 1, source `e1d14b9cd0fa1d7896b58e513f9040639e9e4940`, failed the original POSIX observation step 25 on both Darwin architectures. The two complete original decoded logs were fetched once; no artifact was downloaded or test executed for this audit.

Darwin x64 job `133120929424` first retained `compiler-default:baseline` at 06:21:57 UTC with stage `kernel-image-validity`, errno 13 and code-signing error −67062. Its first assertion is actual 13 versus expected 0 at the unchanged native test line 476. The same log also retains both `adhoc-test-only:after-check` and `adhoc-test-only:writer-open` mutation counterexamples.

Darwin ARM64 job `133120929495` retains those two mutation counterexamples at 06:23:21 UTC. Its first assertion is the original zero-marker rule at native test line 496: actual `LIB\nBIN:A\nMAIN:A\n` versus empty. This ARM log does not print the unsigned-baseline error; the x64 −67062 fact is not transferred to ARM.

All four mutation rows report the original stopped-before-user/image observation, matched image, resumed execution and exit 0, followed by library, constructor-A and main-A markers. Each reports original reaped, original group absent and cleanup true. Those cleanup facts do not satisfy the zero-marker oracle. Original test and workflow source bodies have been rehashed against the immutable e1d tree in `audit.json`.

The existing P09 strict HOLD remains. No supported same-contract repair is selected by these observations, and no trusted-writer, signing, copy, pathname, script or timeout exception is inferred. Existing independent work may continue without changing that owner contract. No broader OS research or native experiment was performed.
