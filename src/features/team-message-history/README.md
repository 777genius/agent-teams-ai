# Team message history

Producer-only slice: pure message version/progress policy in `core/domain`, inbox
window orchestration in `main/application`, hashing/error compatibility in
`main/infrastructure`. Services enter through `main/index.ts`; successful window
contracts live in `contracts`.

The reader supplies narrow filesystem/normalization ports. Strict windows validate
guarded raw input independently of tolerated legacy full-read caches. A validated
inbox window proves only its listed inbox sources, not all lead/sent disk history.
Errors use bounded path-free text for the existing worker transport. The page
policy restricts both displayed and durable overlay rows to a globally proven raw
prefix; empty depletion fails explicitly. It does not implement refill, eviction,
archival, atomic snapshots, body release or measured resource budgets.

`TeamMessageHistoryRetrievalGate.test.ts` exercises actual reader/feed fixture
behavior, including dedup depletion, cross-source frontier crossing, metadata
versioning, first-winner ties, failure recovery and equal-time replay. Existing
reader/feed tests protect successful compatibility and no full-read fallback.
