# Member log reads

The initial main-process cache integration uses `DetailCacheFillFence` through
`main/index.ts`. It separates permission to cache a result from source validity,
retains latest-writer ownership until every outstanding fill settles, and fences
invalidation and disposal. It stores neither completed payloads nor key tombstones.

Renderer subscriptions, completion polling and main detail-read coalescing remain
separate integration work in the accepted PR6a/6b plan.
