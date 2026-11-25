# 46. Original Composer command availability

**Selected narrow follow-up; no source applied yet.** Parent: `18ccdac31a566e7353e8575c2eaa575fb76e4a35`, tree `462004a11ab147e289800da080a0b83c9059987a`. Preserve the already published Plan47 and complete preceding history. Exact implementation preimages were verified at `168bf0cbcb9c51e9c4a4120e0932b8f2cf26eb27`; the three behavior/test files are byte-identical to original failing primary `a07e2d68ece77d08e152d7b0de1eb4b85d72ca06`.

Revision3 incorporates independent prospective R2 and supersedes the first two design snapshots. The original dynamic triggerChars expression stays byte-for-byte unchanged: adding '/' permanently would break existing '@src/file' scanning while command suggestions are unavailable. Root selected the scalar-transition guard and a raw pending observation described below; this note remains prospective until the plan is published.

## Original evidence and its limit

Original run43892535269/job133387314546, artifact14245382466 is 1,568,852 bytes, SHA256 `2ad4a88265ee99060cb91ec1ab24a99c858673781a272056cdfe148eac155681`. It is retained in this directory. The receipt's clean source head is exact a07; original UI result is INCOMPLETE.

The first native-command iteration requests /compact. Original `sendDesktopNativeCommandFromComposer` physically focuses the Composer, verifies its empty value, inserts one '/', then waits using the original default30s `waitRead` for '/compact' in the actual suggestion list. That wait fails; no command-selection click or Send is reached. The screenshot and bounded after-failure snapshot agree: one focused, connected, enabled, writable textarea contains exactly '/', cursor1, but listboxes/options are both zero. The selected raw captured member catalog has four commands at failure. The original stream, deny/allow approval and answer/decline question paths had completed before this command loop; the visible last reply is 'TEST question declined'. Later native commands, Stats, scheduled paths, reload and original Team Stop are not qualified by this run.

The artifact does not retain component-prop catalog availability at the original insert, nor input/select callback order. Accordingly, neither defect below is asserted to be the historical cause. They are independently reachable defects of the current hook under supported asynchronous input/catalog updates.

## Exact planned paths

| Existing path | Preimage blob | Current physical lines | Proposed role |
| --- | --- | ---: | --- |
| src/renderer/hooks/useMentionDetection.ts | d0c4d0c3ddccf8caf13a13dbfe5971ad0678f96e | 379 | Own current-text detection and a bounded deferred input observation after a no-active-trigger result. |
| src/renderer/components/ui/MentionableTextarea.tsx | 94a360626de2ee67ceac964e3fd8529d345e3843 | 1431 | Pass every non-IME keydown to the hook's already guarded handler; preserve original dynamic triggerChars. |
| test/renderer/hooks/useMentionDetection.test.ts | 83be0ff8e2b731490fbef7c51175dff110036947 | 70 | Preserve all original parser cases and add actual-hook behavior regressions. |
| scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts | 0fe5cdf19fdd28b224c505d831bea97d89837d05 | 329 | Append only the two changed production dependencies to the common supplementary roster. |
| .github/workflows/host-emulated-acceptance.yml | 34e7447dffd5ce545f17cbe873db91aa975d43ea | 1360 | Append only the existing hook test path to the existing fast-lint operand list. Full renderer typed lint and complete safe frontend shard already cover the changed behavior. |

Current complete hook is saved at `source/src/renderer/hooks/useMentionDetection.ts` under this directory. Its SHA256 is `0223931871187f7e905acdf23d3386c627264885c7b61d6dcbfb269b6aa450c3`. Textarea SHA256 is `12bd4d337c50ac6308e72e583f29b791be3c9effe7b8b71dcdefa2cc9676133a`; original test SHA256 is `6ca184c42ebce75b4c288a494aabead295ba984ebcbc82c388c4d8c411dcc8e0`.

The existing size baseline `8f5deeed4e406894e1ee587ed541014bcb7dde77` freezes Textarea at1431. Removing only the redundant outer open/count guard around the hook key handler reduces its physical size by two lines. No baseline exception or cap increase is proposed. Hook remains below800. Estimated implementation is roughly60–100 net hook lines and180–260 test lines; exact counts must be reviewed after implementation. The existing fast-lint list has117 operands, all of which must retain their order before the single new test operand.

## Reachable defects

1. While commandSuggestions is empty, Textarea omits '/' from triggerChars. One actual '/' change is accepted into the draft but the hook dismisses the dropdown. When the captured catalog later arrives, callbacks are recreated, but no availability transition reevaluates the unchanged current input. The dropdown stays closed until another select/change.
2. handleSelect reads selectionStart from the live textarea, but detectTrigger reads its render-captured value. A callback associated with old empty text can dismiss a just-entered current '/' even though the actual textarea and caret form a valid trigger.

## Bounded correction

Keep trigger recognition, availability, validation and dropdown ownership in the existing hook. Do not add a helper module, timeout, polling loop, network request, synthetic event or retry.

- Both change and select pass the actual textarea text and caret into the same private detection/activation logic. In particular, select reads `event.currentTarget.value`, not render-captured `value`. Position measurement receives that same text. Existing change notification, insertion, caret writes and navigation semantics stay at their original owners.
- Keep the caller's original dynamic triggerChars unchanged. Use one nullable pending observation only after an actual focused, editable, collapsed change/select produces no active trigger. This is an observation of input, not a declaration that a slash or any other trigger is valid. It contains the original element, exact text and selection endpoints; it does not copy a catalog or acquire provider authority.
- Derive a canonical scalar signature of currently enabled supported trigger characters (deduplicated and ordered). One prior-signature ref gates the availability effect. Its very first operation compares old/new scalar signatures and returns on equality, before reading DOM or touching state/pending. Exhaustive dependencies may include the original inline arrays/predicates; their identity-only rerenders do nothing beyond that equality return. Use no extra effect or render-time latest-rules ref mutation.
- On a genuine scalar availability transition, inspect only the pending observation. Admit it only if the ref still denotes the identical connected focused editable element, current text and collapsed caret exactly match the observation, and the original find/enable/validate rules now produce a valid enabled trigger. Clear pending before opening through the same stable activation helper. Mismatch clears pending; a still-unavailable/unrecognized trigger remains closed with at most the original one pending observation. No state update occurs when there is no pending observation. Plain text and invalid slash prefixes cannot bypass the original rules.
- Explicit dismiss clears pending as well as existing open/query/index/position state. An internal no-active close may record the one current eligible observation only after reset. Real input/selection replaces it; a range, readonly/disabled field or unfocused target leaves none.
- A non-IME Escape delivered while the dropdown is closed cancels the pending observation without new preventDefault/stopPropagation. The textarea currently calls the hook key handler only when the menu is already open with options; remove that redundant outer condition, since the hook already guards those cases. Preserve the old scope of its following early return explicitly: `if (isOpen && effectiveSuggestions.length > 0 && e.defaultPrevented) return;`. Otherwise an already-defaultPrevented closed-menu event would gain an unrelated short-circuit. Preserve the existing special above-popup Escape handling and the existing early IME return.
- No new blur listener is required. Availability admission requires current focus and clears pending on mismatch. This proves current-focus refusal, not uninterrupted focus through an unobserved blur/refocus interval. A later genuine select/change remains the original way to express new input intent.

### Explicit UX boundary

The behavior change is limited to revisiting one actual unmatched input observation after the supported/enabled trigger set changes. The original supported-trigger expression, all enable/validation predicates and ordinary detection remain intact, including '@src/file' without slash commands. Thus a corresponding late existing '@' or '#' source can also make its existing menu available; no token grammar, provider policy, catalog authority, menu action or insertion behavior is added. Explicit dismissal blocks automatic reopening, including a later availability transition. There is no provider-specific fallback or hardcoded slash rule in the generic hook.

Composition behavior is intentionally limited to the existing contract: IME keydown (isComposing or229) does not navigate, select, submit or dismiss. Existing change/select handling can display suggestions during composition; no new composition-policy state machine is proposed. The new availability effect never writes text, caret or focus or consumes keyboard events.

## Minimal meaningful regressions

Use the existing Vitest/happy-dom environment and existing React createRoot/act pattern; no testing dependency or shared test framework. Mount the actual hook with a real textarea and controlled rule updates.

1. One '/' change while commands are unavailable, followed only by a supported-character arrival: opens with query empty, index0 and valid position, no second input/select, no extra onValueChange, no text/caret/focus mutation. Pair this with '/' already declared but its original enable predicate initially false, then true.
2. Stale select callback invoked before the parent commits its changed value (render value empty, actual currentTarget '/' at caret1): select uses current text and does not dismiss the valid current trigger.
3. Explicit dismiss and non-IME Escape clear pending and keep the menu closed across genuine availability changes and identity-only callback/array rerenders; the closed-menu Escape does not newly prevent or stop the event. A later actual edit can reopen normally.
4. Paired refusal cases: pending text/caret changes, noncollapsed selection, different/disconnected element, blur, readOnly or disabled state prevent deferred activation without changing the input. Keep parameterization local to this file.
5. Original '@src/file' detection works when slash commands are absent. Invalid slash prefix/no trigger stays closed; the actual per-trigger enable/validation gates remain authoritative.
6. Existing ArrowDown/ArrowUp wrapping, repeated same-query select retaining its chosen index, and normal Enter selection remain correct. IME Arrow/Enter/Escape (both composing and229 signals) preserve index/open/pending state and do not prevent/select/submit.

Do not change any original Desktop action, expected catalog, command body, deadline, source guard or literal verifier. The exact resulting-source original Claude UI lane must still pass. Source review and these focused tests do not qualify downstream journey stages or native/vendor operation.

## Publication / validation boundary

This is a prospective plan only. Root selects and publishes Plan46 before any production/test/workflow edits. Implementation then receives exact-byte independent source review. Original full types, typed lint, safe frontend shard and original Claude UI gate remain required on the resulting source. No project command, provider, GUI or CI execution has occurred during this review.

Independent revision3 prospective R2 SHA256: `b20660410c682838af21b099057f7542ee0a32164a8fa6a3fd95ccbadef1bca3`. The reviewed draft SHA256 is `e9b213b46d1cc8f5d99dd694ce8271e070c5f59f8f49c840f8867cf3b46c2afb`; this selected publication adds the actual parent and review binding. Stage1 remains default-off and the PR remains Draft; genuine Claude/Codex execution, Ready, main merge, release/default activation and Stage2 are unselected.
