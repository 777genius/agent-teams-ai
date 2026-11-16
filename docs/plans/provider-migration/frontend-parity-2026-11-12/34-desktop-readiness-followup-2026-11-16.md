# Desktop readiness follow-up — 16 November 2026

## Scope and source

Continue #1192 through the existing `fix/frontend-parity-public-c2f5ff7c` branch, based on `e45c5a73f106d7e71936426c923171adcd27f5b9`. Preserve all existing continuation commits and the original B852 runs. This slice changes two existing Desktop scenario owners and appends five targeted cases to their existing suite.

The original cross-team receipt shows an absent correction submit control after one input attempt. The original installer receipt refuses a moved lead target before clicking. Source review establishes the readiness gaps below; it does not establish the historical cause of either receipt failure.

## Corrections

1. The existing correction-input expression may return a valid owner with `canEditNow=false`. Require strict `canEditNow===true` in its original 30-second read before the original focus/input/submit sequence.
2. Native BOOT settlement can precede the renderer's lead preview. For the first A and B conversation openings, require exactly one original lead row with exactly one `TEST boot ready` preview span before the original scroll and click. Reuse the existing controls with the original renderer-ownership guard and one absolute 60-second deadline shared by preview readiness, opening and the original visible-reply check. Its final post-await click guard refuses a late physical press. The original focus command can precede that guard; no broader zero-effect claim is made.
3. Keep later stream conversation openings and all original source, model, runtime, single-action, geometry, persistence, neighbor and Stop assertions.

Estimated scope: about 30 scenario lines and 220 existing-suite lines; complexity 3/10, reliability 8/10, confidence in the identified source corrections 9/10. Full resulting-source E2E is still required.

## Review and verification

Root reviewed the original receipts and current source. Independent source R2 accepted the strict edit-authority predicate and the corrected installer wrapper, including exact preview identity and post-await cutoff checks. The latter source blob is `838c2c58518ca76ec8cfc50a28aafe4b3319f8b3`; the correction scenario blob is `df76ce10ba52725b11fea48659b4cb516fc6fddf`.

Actual supplemental execution used Node 24.22.1 and the extracted original stages with the actual unchanged controls. The correction cases give 0 PASS / 2 FAIL on the original owner admission and 2 PASS / 0 FAIL on the correction. The installer cases pass 3/3, covering delayed/wrong/duplicate previews, one physical click, decreasing shared budget and expiry after awaited observations. All five cases have zero skips. The complete old suite is preserved as an exact byte prefix.

These checks do not substitute for the complete original suite, pinned TypeScript 7, typed lint, GUI or native qualification. Original resulting-source cross-team, installer, selection and the complete current aggregate remain required. Keep original B jobs running; reconcile the complete current branch before updating the primary PR. P08/P09 and the separately prepared P11 V2 journey remain open. Draft, existing base, finite TEST provider limits, default-off and Stage 2 boundaries remain in force.
