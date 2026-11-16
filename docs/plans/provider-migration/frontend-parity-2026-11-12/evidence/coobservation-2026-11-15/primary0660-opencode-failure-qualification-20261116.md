## Original 0660 OpenCode Desktop failure: retained evidence — 16 November 2026

The original Host Emulated Acceptance run `43780997237`, attempt 1, job `133017915900` used exact source `0660c748f88675063e3051fb0f8b2022e8f6f056` / tree `e70ccffc6d55ad42c2249518bf142e2ed32ddf91`. The job ran 01:24:21–01:27:01 UTC on linux-x64 and failed. Its Desktop prerequisites actually passed 115/115 and its separate installer parser 7/7, with zero failures/skips/cancellations/todos. These are original 0660 results, not qualification of own 2ab.

### Exact original custody

| Evidence | Identity |
| --- | --- |
| Full original raw/API/manifest tree | 04f0ed6b02d6d21aeb9dd21c0801680aceb4beac |
| Original job stdout | 18de3a01b1af208e57279ba29317c6c12637911c; 184,267 bytes; SHA256 e96323c7cd7ec9baba03e6f0c34153b9eec9f99c1b8b9b6b6ba6aa2739e3e422 |
| Original artifact | 14189374994; 665,565-byte ZIP; SHA256 4ebbd3445d8a455746843c471d9115e46502be1909c8a2b7b60110aaa0c57a2e |
| Root-inspected archive payload tree | 30ea85c8549108e5ffec1332e0785a8267bc5d29 |
| Complete receipt | aeb2650c4ce00e53c7a8b746b506d992eac985e0; 756,997 bytes; SHA256 189e97065f05e8afba47064b1eb8c63ffc87d97cc6a4b292fd1ca461a092bde3 |
| Original PNG | 9e1393d49d0cfdfaefec629c2ff7b8e4ed513ee5; 98,967 bytes; SHA256 030e755d3913c47faf2364394dd0caa306f254c631ff482bf269a1ac5969aaaa |
| Root full-byte/API review | 459172e78b553a052191a12ca0bbcc8c1054c9fa |
| Root exact-source freeze review | 98ff6efdf5140ac5c0b4ca7799861be1234fd24b |

Root downloaded the actual ZIP, matched API and original upload size/digest, verified CRCs and all 14 unique safe members, and retained their complete manifest. The complete receipt, app log, step log, manifest and original PNG were uploaded with exact Git identities; the PNG bytes were not taken from a display transcode. Root and independent review read the complete receipt. Both 1,757-entry source lists are unique and exactly equal; root checked every SHA256 against the original 0660 Git blob bytes. The original checkout reports dirty=false.

The five original raw/API/manifest files total 321,716 bytes and were fully checked against Git identities, byte sizes and the manifest's digests. Their source/run/job/artifact/upload joins agree. The root evidence checker initially refused because it incorrectly expected the receipt-only assertion text in stdout. The corrected read-only checker uses the actual stdout failure frames plus complete receipt, and the original Node spec-reporter counters (ℹ), not TAP spelling. That checker correction ran no product/test/build and changed no historical outcome.

### Reached boundary and observations

The failure is the original final target comparison in controls `2ea000d33b7c872a4a1bcd5f2a510c8418924fe5`, line 288, called by runtime UI `1bde37adb7cba710ad77784eedbbe0d6c6e556df`, line 87, while expanding the original saved launch settings. The last recorded action was only its hover at [700, 507.5]. The original stable sample was [700, 494.75, BUTTON]; after the ownership check, the final read was [700, 505.75, BUTTON]. The target still passed the unique visible/enabled/hit-tested lookup, but its y coordinate differed by 11 pixels. The final geometry guard correctly refused before this action's press/release.

No optional-settings click attempt, TEST_UI_BOOT prompt insertion or Launch team action was reached. The command list is empty. The peer effects contain preparation and TEST_MODEL_PROBE activity; they do not establish a business launch. The final screenshot and snapshot retain the closed Optional launch settings surface and a ready/verified model footer. The generic emulatedReadinessFailure summary label does not make this a provider-readiness or timeout failure.

The inspected source provides a possible reflow mechanism: the dialog is vertically centered, and asynchronous preparation replaces footer content. The flow waits for the saved model summary before this expand click, while its explicit preflight-completion wait occurs later. Own runtime UI d526 preserves the same first 94 prelaunch lines. The controls' geometry/action path and the inspected dialog/optional-settings/footer producers remain unchanged from 0660; the whole controls file separately includes the reviewed passive Installer observer. This makes the possibility relevant to the next source, but it does not prove which update caused the measured movement. There are no retained preceding dialog bounds, footer-branch states or stable-read timestamps. No 22-pixel footer change, readiness delay or causal product defect is asserted.

### Cleanup and limits

The original failure Quit was acknowledged and its listener became absent. App exit code is 0. Nevertheless the original process-group census retains PID 4354, PPID 1, PGID 4281, and cleanup reports “captured leader absent; retain cleanup debt without signaling”. Captured Host observation is false and its absence is null. The two finite provider peers are absent in their separate census. Peer absence and app exit therefore do not qualify full app/Host cleanup.

This historical failure remains INCOMPLETE. No retry, additional click, timer extension, guard relaxation, source change, rerun/cancellation or real Claude/Codex invocation was performed to reconstruct it. The Installer navigation diagnostic is separately qualified and does not claim to explain this button-layout failure. Future source changes require a concrete reviewed finding; any new successful job must remain bound to its own exact source and original assertions.
