
## Exact implementation review and local controlled evidence

R1 implemented the three existing ownership layers; independent R2 root accepted
the full-config/source-grant Runtime fence and the cross-layer contracts. R2
`/root/p09_review` inspected capture framing, real original-child attachment,
redaction compatibility and cleanup. Root found a post-decoding byte expansion
case:10KiB invalid UTF-8 or NUL bytes can become30KiB sanitized UTF-8. The final
helper applies the24KiB bound to sanitized bytes as well and emits an oversized
gap. Both reviewers rechecked the correction and its two expansion canaries.

The pure redactor move preserves existing app behavior. The selected-value
classifier has a distinct purpose from the legacy assignment redactor and
covers already-held credential/cookie/private-key values without reading more
credentials. No equivalent existing selector was found; broadening the old
sanitizer would change its callers, so the small private selector is retained.

Root independently compared the codec extraction: all five primitives are
unchanged; the existing activity block differs only by the new top-level
stderr validation and rejection of nested or input-attributed process output.
Every caller outside the extraction is unchanged. The private decoder is317
lines and its existing caller500; RuntimeTeamCoordinator stays exactly800.
The existing supplementary source roster includes these actual producer/read/
renderer leaves and their reused diagnostic, Markdown and read-owner sources.

The final controlled Node24.21.0 run covers the seven existing/helper suites:
runtime-activity, member-provider-authority, member-process-stderr,
codex-member-provider, captured-claude-process, owned-process-facade and
team-activity-read. It passes92/92,0 skipped. The final six focused Vitest
suites pass62/62; three original diagnostic-consumer suites pass40/40.
Host build/test types, scoped feature/renderer/script TypeScript7, source-size,
architecture, scoped lint and diff checks pass. Actual graphical Desktop
acceptance and resulting-source native platform gates are still required.
No real Claude or Codex executable was used; the process suites use finite
controlled children.

Ordinary process facts do not alter messages, usage, previews, conversation,
readiness or custody. An explicit oversized/storage gap retains the existing
uncertainty policy, including unknown cost when evidence is incomplete.
Preserve that policy rather than inventing a diagnostic-specific exemption.
