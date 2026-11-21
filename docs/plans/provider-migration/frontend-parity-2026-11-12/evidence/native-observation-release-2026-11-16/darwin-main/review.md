# e1d Darwin x64 process prerequisite failure

Original job133120929324/run43813731530, attempt1, fails step10 in capturedHostClient.test.ts356, case `holds Main reply bytes before native effect, expiry=true`. The first error is `TEST native call never reached Main admission`. It is a finite Main/Host transport assertion before original POSIX/provider lifecycle qualification, not the separate Darwin P09 signature/zero-marker gate.

The original Node24.21.0/pnpm11.22.0 frozen install and controller/Host build passed. The Node contract command recorded167 cases:165PASS,0FAIL,2explicit Linux-only SKIPs. The native broker protocol Vitest command passed54/54. The complete eight-file Main command recorded80PASS/1FAIL; capturedHostClient itself was32PASS/1FAIL of33. The separate desktopBackendFeature file passed16/16. No result is transferred to Team177/typed-renderer, which has not yet run in this cohort.

The failed case first observes completion of the original1MiB child stdin write while holding only its Main callback, then requires Main nativePending Map.set before the request resolves. The request resolved first. The finite Host fixture gives the expiry=true reverse call performance.now()+20, but the returned status and emission/admission times are absent from the failure. The source makes pre-admission expiry possible; it does not establish that this was the actual branch. No clock increase, replay, relaxed witness or production fix is selected. Later zero-effect/control/expiry assertions were not reached.

Artifact14202660278 is11052 bytes/SHA2562960ac3be2e4b1241d78a74a52600b55ff2fd42b2e3eddb0c7766b3a171df039. Its four members are the three contract logs and exact e1d source-head.txt. The failed test has a finally block restoring the gate and awaiting transport shutdown, but no explicit returned shutdown/natural child-exit receipt is retained. Platform lifecycle and provider A/B stages were skipped after the first failure. No native/process qualification is claimed.

Only the original log/artifact and immutable e1d source bytes were read. No project import/test/build/native/provider/GUI execution or workflow/source mutation occurred.
