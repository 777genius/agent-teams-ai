# External Docs Verification

Every programmatic choice (framework feature, library API, config knob, CLI flag, deployment pattern) is verified against external authoritative sources BEFORE commit.

## Rules

1. **Verify against official docs first.** When using a framework feature, library function, or config option, read the current official documentation — not the version remembered from training data.
2. **Cross-check with expert articles + reference repos.** For non-trivial patterns (auth flows, gRPC + mTLS, exactly-once messaging, identity/SPIFFE integration, etc.), find at least one expert article AND at least one production repo implementing the pattern. Cite both in the change summary or commit message.
3. **Doc-grounded falsification beats memory.** If your recollection contradicts current docs, current docs win. Update memory to match.
4. **Pin versions when citing.** "Spring Boot 3.2.x" not "Spring Boot". "React 19.0.0" not "React". APIs change between minor versions; vague citations decay.
5. **Re-verify at checkpoints.** Spike outputs, design-doc deliverables, and ADR amendments all re-validate the assumptions they depend on. Doc drift is silent; only periodic re-verification catches it.
6. **Use `WebFetch` / `WebSearch` / `technical-researcher` agent.** Don't guess. Spawn a `technical-researcher` agent in parallel with other work if verification is needed.

## When NOT verifying

Trivial language constructs (loop syntax, standard library functions whose signatures haven't changed in 5+ years), or facts already verified within the current session against current docs.

## Verification

Before merging any commit that introduces or changes a programmatic choice:

- Cite the doc URL or repo path in the commit message or change summary.
- If verification surfaced a falsification of an earlier assumption, update the relevant ADR + Memora memory.

## Anti-patterns

- "I think the framework supports per-namespace max_message_size" — guess. Verify against the official doc URL before claiming.
- "This feature works compile-time" — claim that requires citing the relevant docs.
- Copy-paste from a Stack Overflow answer without checking when it was written or against which library version.

## Reason

Doc-grounded verification is the cheapest defensive measure in any project. The cost of an extra `WebFetch` is minutes; the cost of a wrong assumption baked into design is months.
